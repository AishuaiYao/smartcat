const app = getApp()

Page({
  data: {
    imageData: null,
    frameCount: 0,
    streaming: false,
    delayMs: 0,
    debugMode: false,
    running: false,
    speed: 20,
    kp: 0.50,
    motorA: 0,
    motorB: 0,
    voltage: 0
  },

  lastFrameTime: 0,
  imgSocket: null,          // 图像TCP连接
  recvBuffer: null,         // 接收缓冲区（Uint8Array动态增长）
  FRAME_HEADER_SIZE: 7,     // 帧头: [帧号2B][电压1B][左PWM1B][右PWM1B][G1(顶部质心)1B][G2(底部质心)1B] = 7
  FRAME_IMAGE_SIZE: 19200,  // 图像数据: 160x120
  FRAME_PACKET_SIZE: 19207, // 每帧总大小
  chartCtx: null,           // 误差图表canvas上下文
  errorHistory: [],         // 误差历史数据 [G0-C误差值]
  g1g2DiffHistory: [],      // G1-G2差值历史数据
  MAX_ERROR_POINTS: 100,    // 图表最多显示点数

  onLoad(options) {
    console.log('[Experiment] ========== 页面加载(TCP模式) ==========')
    console.log('[Experiment] debug=' + options.debug + ', connected=' + app.globalData.connected)
    
    if (options.debug === '1') {
      this.setData({ debugMode: true, streaming: true })
      this.generateDebugImage()
      return
    }
    
    if (!app.globalData.connected) {
      console.log('[Experiment] !!! 设备未连接，返回')
      wx.showToast({ title: '设备未连接', icon: 'none' })
      wx.navigateBack()
      return
    }
    
    console.log('[Experiment] 注册回调，自动开始实验')
    this.registerCallbacks()

    // 进入页面立即发送EXPERIMENT命令，建立图像通道
    console.log('[Experiment] 自动发送EXPERIMENT命令')
    app.sendCommand('EXPERIMENT')
  },

  onReady() {
    this.initErrorChart()
  },

  initErrorChart() {
    const query = wx.createSelectorQuery().in(this)
    query.select('#errorChart').fields({ node: true, size: true }).exec((res) => {
      if (!res[0] || !res[0].node) {
        console.warn('[Chart] canvas节点未找到')
        return
      }
      const canvas = res[0].node
      const ctx = canvas.getContext('2d')
      const dpr = wx.getSystemInfoSync().pixelRatio
      canvas.width = res[0].width * dpr
      canvas.height = res[0].height * dpr
      ctx.scale(dpr, dpr)
      this.chartCanvas = canvas
      this.chartCtx = ctx
      console.log('[Chart] 初始化完成, 尺寸=' + res[0].width + 'x' + res[0].height)
      // 立即绘制空坐标系
      this.drawErrorChart()
    })
  },

  drawErrorChart() {
    const ctx = this.chartCtx
    if (!ctx || !this.chartCanvas) return

    const dpr = wx.getSystemInfoSync().pixelRatio
    const W = this.chartCanvas.width / dpr
    const H = this.chartCanvas.height / dpr
    const padL = 40, padR = 12, padT = 20, padB = 28
    const chartW = W - padL - padR
    const chartH = H - padT - padB

    // 清空背景
    ctx.fillStyle = '#111'
    ctx.fillRect(0, 0, W, H)

    // 标题
    ctx.font = 'bold 9px monospace'
    ctx.fillStyle = '#9C27B0'
    ctx.textAlign = 'center'
    ctx.fillText('Error (px)', W / 2, 14)
    // 图例
    ctx.font = '9px monospace'
    ctx.fillStyle = '#00CC88'
    ctx.textAlign = 'left'
    ctx.fillText('— G0-C', padL + 4, 14)
    ctx.fillStyle = '#FF8844'
    ctx.fillText('— G1-G2', padL + 50, 14)

    // 绘图区域边框
    ctx.strokeStyle = '#333'
    ctx.lineWidth = 0.5
    ctx.strokeRect(padL, padT, chartW, chartH)

    // ===== 自动计算Y轴范围（不截断，自适应缩放）=====
    let yMin = 0, yMax = 80  // 默认范围
    const data = this.errorHistory
    if (data.length >= 2) {
      const maxPts = this.MAX_ERROR_POINTS
      const startIdx = data.length > maxPts ? data.length - maxPts : 0
      const displayData = data.slice(startIdx)
      const absMax = Math.max(...displayData.map(Math.abs), 1)
      // 向上取整到漂亮的数字: 10/20/40/80
      yMax = absMax <= 10 ? 10 : (absMax <= 20 ? 20 : (absMax <= 40 ? 40 : (absMax <= 80 ? 80 : Math.ceil(absMax / 20) * 20)))
    }

    // ===== 网格线（细网格 + 主网格）=====
    // 水平网格线：每1/4范围一条细线
    const hSteps = 8
    for (let i = 0; i <= hSteps; i++) {
      const y = padT + (i / hSteps) * chartH
      const isMajor = (i === hSteps / 2) || (i === 0) || (i === hSteps)
      ctx.beginPath()
      ctx.strokeStyle = isMajor ? '#888' : '#555'
      ctx.lineWidth = isMajor ? 0.6 : 0.3
      ctx.setLineDash(isMajor ? [3, 3] : [])
      ctx.moveTo(padL, y)
      ctx.lineTo(padL + chartW, y)
      ctx.stroke()
      ctx.setLineDash([])

      // Y轴标签（每条主网格线都标）
      if (i % 2 === 0) {
        const val = yMax - (i / hSteps) * 2 * yMax
        ctx.font = isMajor ? '9px monospace' : '8px monospace'
        ctx.fillStyle = isMajor ? '#ccc' : '#999'
        ctx.textAlign = 'right'
        ctx.fillText((val >= 0 ? '+' : '') + val.toFixed(0), padL - 4, y + 3)
      }
    }

    // 垂直网格线：每1/10宽度一条
    const vSteps = 10
    for (let i = 0; i <= vSteps; i++) {
      const x = padL + (i / vSteps) * chartW
      const isMajor = (i % 5 === 0)
      ctx.beginPath()
      ctx.strokeStyle = isMajor ? '#555' : '#3a3a3a'
      ctx.lineWidth = isMajor ? 0.4 : 0.3
      ctx.setLineDash(isMajor ? [] : [])
      ctx.moveTo(x, padT)
      ctx.lineTo(x, padT + chartH)
      ctx.stroke()

      // 每条线都显示X轴标签
      if (vSteps > 0) {
        ctx.font = isMajor ? '8px monospace' : '7px monospace'
        ctx.fillStyle = isMajor ? '#999' : '#666'
        ctx.textAlign = 'center'
        ctx.fillText(Math.round(i / vSteps * this.MAX_ERROR_POINTS), x, H - 4)
      }
    }
    
    // X轴标签
    ctx.font = '8px monospace'
    ctx.fillStyle = '#666'
    ctx.textAlign = 'center'
    ctx.fillText('frame', padL + chartW / 2, H - 2)

    // 绘制误差曲线（G0-C误差，自适应Y轴，不截断）
    if (data.length < 2) return

    const maxPts = this.MAX_ERROR_POINTS
    const startIdx = data.length > maxPts ? data.length - maxPts : 0
    const displayData = data.slice(startIdx)

    ctx.beginPath()
    ctx.strokeStyle = '#00CC88'
    ctx.lineWidth = 1.5
    for (let i = 0; i < displayData.length; i++) {
      const x = padL + (i / (maxPts - 1)) * chartW
      const val = displayData[i]
      // 自适应缩放，不clamp
      const y = padT + chartH / 2 - (val / yMax) * (chartH / 2)
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()

    // 绘制G1-G2差值曲线（橙色）
    const diffData = this.g1g2DiffHistory.slice(startIdx)
    if (diffData.length >= 2) {
      ctx.beginPath()
      ctx.strokeStyle = '#FF8844'
      ctx.lineWidth = 1.5
      for (let i = 0; i < diffData.length; i++) {
        const x = padL + (i / (maxPts - 1)) * chartW
        // G1-G2差值用同一Y轴范围绘制
        const y = padT + chartH / 2 - (diffData[i] / yMax) * (chartH / 2)
        if (i === 0) ctx.moveTo(x, y)
        else ctx.lineTo(x, y)
      }
      ctx.stroke()
    }

    // 当前值标记（G0-C误差）
    if (displayData.length > 0) {
      const lastVal = displayData[displayData.length - 1]
      const lastX = padL + ((displayData.length - 1) / (maxPts - 1)) * chartW
      const lastY = padT + chartH / 2 - (lastVal / yMax) * (chartH / 2)

      // 当前点圆圈
      ctx.beginPath()
      ctx.arc(lastX, lastY, 3, 0, 2 * Math.PI)
      ctx.fillStyle = '#00FFAA'
      ctx.fill()

      // 当前error数值
      ctx.font = 'bold 9px monospace'
      ctx.fillStyle = '#00FFAA'
      ctx.textAlign = 'left'
      ctx.fillText(lastVal.toFixed(1), lastX + 5, lastY + 3)

      // G1-G2差值当前值标记（在曲线末端位置，不带Δ符号）
      if (diffData.length > 0) {
        const diffVal = diffData[diffData.length - 1]
        const diffLastX = padL + ((diffData.length - 1) / (maxPts - 1)) * chartW
        const diffLastY = padT + chartH / 2 - (diffVal / yMax) * (chartH / 2)

        ctx.beginPath()
        ctx.arc(diffLastX, diffLastY, 3, 0, 2 * Math.PI)
        ctx.fillStyle = '#FF8844'
        ctx.fill()

        ctx.font = 'bold 9px monospace'
        ctx.fillStyle = '#FF8844'
        ctx.textAlign = 'left'
        ctx.fillText(diffVal.toFixed(1), diffLastX + 5, diffLastY + 3)
      }
    }
  },

  onUnload() {
    console.log('[Experiment] 页面卸载')
    this.removeCallbacks()
    
    if (this.imgSocket) {
      app.sendCommand('STOP_EXPERIMENT')
      this.imgSocket.close()
      this.imgSocket = null
    }
    this.recvBuffer = null
  },

  registerCallbacks() {
    this.onMessageBound = this.onMessage.bind(this)
    this.onCloseBound = this.onClose.bind(this)
    this.onErrorBound = this.onError.bind(this)
    app.addMessageCallback(this.onMessageBound)
    app.addCloseCallback(this.onCloseBound)
    app.addErrorCallback(this.onErrorBound)
  },

  removeCallbacks() {
    app.removeMessageCallback(this.onMessageBound)
    app.removeCloseCallback(this.onCloseBound)
    app.removeErrorCallback(this.onErrorBound)
  },

  onMessage(res) {
    const bytes = new Uint8Array(res.message)
    const str = String.fromCharCode(...bytes.subarray(0, Math.min(bytes.length, 50)))
    console.log('[Experiment] TCP消息: ' + str)
    
    if (str.includes('IMG_OK')) {
      console.log('[Experiment] 命令通道收到IMG_OK(忽略，图像通道独立处理)')
      return
    }
    
    if (str.includes('WAITING_IMG_CONN')) {
      console.log('[Experiment] ESP32等待图像连接，立即建立图像TCP')
      this.setupImageTCP()
      return
    }
    
    if (str.includes('IMG_NOT_READY') || str.includes('IMG_CONN_FAILED')) {
      console.log('[Experiment] 图像通道失败')
      wx.showToast({ title: '图像通道建立失败', icon: 'none' })
      return
    }

    // 兼容旧UDP相关响应（防止误触发）
    if (str.includes('UDP_OK') || str.includes('UDP_NOT_READY')) {
      console.log('[Experiment] 收到旧的UDP相关消息，忽略')
      return
    }
  },

  onClose() {
    console.log('[Experiment] TCP命令连接已关闭')
    this.setData({ streaming: false })
  },

  onError(err) {
    console.log('[Experiment] TCP连接错误:', err)
    wx.showToast({ title: '连接断开', icon: 'none' })
    this.setData({ streaming: false })
  },

  setupImageTCP() {
    console.log('========== 图像TCP初始化 ==========')
    
    const imgSock = wx.createTCPSocket()
    if (!imgSock) {
      console.log('[Experiment] 创建图像TCPSocket失败')
      wx.showToast({ title: '创建连接失败', icon: 'none' })
      return
    }
    this.imgSocket = imgSock
    this.recvBuffer = new Uint8Array(0)

    imgSock.onConnect(() => {
      console.log('[Experiment] 图像TCP连接成功，发送握手')
      imgSock.write('IMG_CONN\n')
    })

    imgSock.onMessage((res) => {
      const t0 = Date.now()
      const newData = new Uint8Array(res.message)

      // 检查是否为握手响应（首条消息可能是文本）
      if (this.recvBuffer.length === 0 && newData.length < 20) {
        const str = String.fromCharCode(...newData)
        console.log('[ImgTCP] 收到: ' + str)
        if (str.includes('IMG_OK')) {
          console.log('[ImgTCP] 图像通道就绪，开始渲染画面')
          this.setData({ streaming: true })
          return  // 握手响应，不是帧数据
        }
      }

      // [诊断] 空窗检测
      if (this.lastMsgTime > 0) {
        const gap = t0 - this.lastMsgTime
        if (gap > 200) {
          console.log('[GAP] onMessage空闲+' + gap + 'ms')
        }
      }
      this.lastMsgTime = t0

      // 追加到接收缓冲区
      const merged = new Uint8Array(this.recvBuffer.length + newData.length)
      merged.set(this.recvBuffer)
      merged.set(newData, this.recvBuffer.length)
      this.recvBuffer = merged

      // 尝试提取完整帧
      this.extractFrames()
    })

    imgSock.onClose(() => {
      console.log('[Experiment] 图像TCP已关闭')
      this.setData({ streaming: false })
    })

    imgSock.onError((err) => {
      console.log('[Experiment] 图像TCP错误:', err)
    })

    console.log('[Experiment] 发起图像TCP连接...')
    imgSock.connect({
      address: app.globalData.esp32IP,
      port: app.globalData.esp32Port   // 同端口5000，第二条连接
    })
    console.log('=====================================')
  },

  extractFrames() {
    const pktSize = this.FRAME_PACKET_SIZE
    
    while (this.recvBuffer.length >= pktSize) {
      const tExtractStart = Date.now()

      // 提取一帧
      const frameBytes = this.recvBuffer.slice(0, pktSize)
      this.recvBuffer = this.recvBuffer.slice(pktSize)

      // 解析帧头
      const frameNum = (frameBytes[0] << 8) | frameBytes[1]
      const voltageRaw = frameBytes[2]
      const voltage = (voltageRaw / 10).toFixed(1)
      const motorA = (frameBytes[3] * 100 / 255).toFixed(1)
      const motorB = (frameBytes[4] * 100 / 255).toFixed(1)
      const g1 = frameBytes[5]   // G1: 顶部质心x
      const g2 = frameBytes[6]   // G2: 底部质心x

      // 计算误差: 用(G1+G2)/2与图像中点80比较
      const mid_x = (g1 + g2) / 2
      const error = 80 - mid_x

      // 仅在电机运行时收集误差数据并绘制图表
      if (this.data.running) {
        this.errorHistory.push(error)
        if (this.errorHistory.length > this.MAX_ERROR_POINTS * 2) {
          this.errorHistory = this.errorHistory.slice(-this.MAX_ERROR_POINTS)
        }
        this.g1g2DiffHistory.push(g1 - g2)
        if (this.g1g2DiffHistory.length > this.MAX_ERROR_POINTS * 2) {
          this.g1g2DiffHistory = this.g1g2DiffHistory.slice(-this.MAX_ERROR_POINTS)
        }

        // 更新误差曲线图
        this.drawErrorChart()
      }

      this.setData({ voltage, motorA, motorB })

      // 提取图像数据
      const grayData = frameBytes.slice(this.FRAME_HEADER_SIZE)

      // 计算帧间隔
      const now = Date.now()
      if (this.lastFrameTime > 0) {
        const delta = now - this.lastFrameTime
        this.setData({ delayMs: delta < 2000 ? delta : 0 })
      }
      this.lastFrameTime = now

      const frameCount = this.data.frameCount + 1
      this.setData({ frameCount })

      const extractCost = Date.now() - tExtractStart
      console.log('[Recv] 帧' + frameCount + '(ESP32帧' + frameNum + '): 提取耗时' + extractCost + 'ms, 缓冲剩余' + this.recvBuffer.length + 'B, 帧间隔' + this.data.delayMs + 'ms')

      // 处理图像
      this.processImage(grayData, { g1: g1, g2: g2 }, Date.now())
    }
  },

  processImage(grayData, pidData, tAssembleEnd) {
    const t0 = Date.now()
    console.log('[Process] 进入processImage, 距提取完成+' + (t0 - tAssembleEnd) + 'ms')
    
    const width = 160, height = 120
    const rgbaData = new Uint8ClampedArray(width * height * 4)

    for (let i = 0; i < grayData.length; i++) {
      rgbaData[i * 4] = grayData[i]
      rgbaData[i * 4 + 1] = grayData[i]
      rgbaData[i * 4 + 2] = grayData[i]
      rgbaData[i * 4 + 3] = 255
    }

    const t1 = Date.now()

    const canvas = wx.createOffscreenCanvas({ type: '2d', width, height })
    const ctx = canvas.getContext('2d')
    const imgData = ctx.createImageData(width, height)
    imgData.data.set(rgbaData)
    ctx.putImageData(imgData, 0, 0)
    
    const t2 = Date.now()

    // ========== 绘制G1/G2质心点和参考信息 ==========
    if (pidData) {
      const g1 = pidData.g1          // G1: 顶部质心x (图像上方区域)
      const g2 = pidData.g2          // G2: 底部质心x (图像下方区域)
      console.log('[Draw] G1=' + g1 + ' G2=' + g2 + ' pidData=', JSON.stringify(pidData))
      const target_x = 80            // 图像中点

      // 十字准星参考线（虚线绿色）
      ctx.beginPath()
      ctx.setLineDash([4, 4])
      ctx.moveTo(10, 60); ctx.lineTo(150, 60)
      ctx.moveTo(80, 10); ctx.lineTo(80, 110)
      ctx.strokeStyle = '#00CC00'; ctx.lineWidth = 1
      ctx.stroke()
      ctx.setLineDash([])

      // 中心点C
      ctx.beginPath()
      ctx.arc(target_x, 60, 5, 0, 2 * Math.PI)
      ctx.strokeStyle = '#00FF00'; ctx.lineWidth = 2
      ctx.stroke()
      ctx.font = 'bold 10px monospace'
      ctx.fillStyle = '#00FF00'
      ctx.textAlign = 'left'
      ctx.fillText('C', target_x + 6, 70)

      // G1点：顶部区域，橙红实心圆
      const g1_y = 20
      const diff = (g1 - g2).toFixed(1)
      ctx.beginPath()
      ctx.arc(g1, g1_y, 3, 0, 2 * Math.PI)
      ctx.fillStyle = '#FF8844'
      ctx.fill()
      ctx.font = 'bold 10px monospace'
      ctx.fillStyle = '#FF8844'
      ctx.textAlign = 'right'
      ctx.fillText('G1:' + g1.toFixed(0), g1 - 6, g1_y + 4)
      ctx.textAlign = 'left'
      ctx.fillText(diff, g1 + 6, g1_y + 4)

      // G2点：底部区域，紫红实心圆
      const g2_y = 100
      ctx.beginPath()
      ctx.arc(g2, g2_y, 3, 0, 2 * Math.PI)
      ctx.fillStyle = '#CC88FF'
      ctx.fill()
      ctx.font = 'bold 10px monospace'
      ctx.fillStyle = '#CC88FF'
      ctx.textAlign = 'right'
      ctx.fillText('G2:' + g2.toFixed(0), g2 - 6, g2_y + 4)

      // G1-G2 连线（表示偏差方向）
      ctx.beginPath()
      ctx.moveTo(g1, g1_y); ctx.lineTo(g2, g2_y)
      ctx.strokeStyle = '#AA6699'; ctx.lineWidth = 1.5
      ctx.stroke()

      // 中点G0标记（红色）+ 与C差值
      const midX = (g1 + g2) / 2
      ctx.beginPath()
      ctx.arc(midX, 60, 3, 0, 2 * Math.PI)
      ctx.fillStyle = '#FF4444'
      ctx.fill()
      ctx.font = 'bold 10px monospace'
      ctx.fillStyle = '#FF4444'
      ctx.textAlign = 'left'
      ctx.fillText('G0', midX + 5, 64)

      ctx.font = 'bold 10px monospace'
      ctx.fillStyle = '#00FF00'
      ctx.textAlign = 'center'
      ctx.fillText((target_x - midX).toFixed(1), target_x, 52)
    }

    const t3 = Date.now()
    const frameCount = this.data.frameCount

    console.log('[Draw] 帧' + frameCount + ': RGBA+' + (t1-t0) + 'ms Canvas+' + (t2-t1) + 'ms 绘图+' + (t3-t2) + 'ms | 准备转tempFile')

    wx.canvasToTempFilePath({
      canvas,
      success: (res) => {
        const t4 = Date.now()
        this.setData({ imageData: res.tempFilePath })
        const totalCost = t4 - t0
        const tempFileCost = t4 - t3
        console.log('[Render] 帧' + frameCount + ': tempFile耗时' + tempFileCost + 'ms, 总渲染' + totalCost + 'ms')
      }
    })
  },

  onStartStop() {
    const running = !this.data.running
    this.setData({ running })
    if (this.data.debugMode) return
    if (running) {
      console.log('[Experiment] 发送START启动电机')
      // 清空误差数据，开始新一轮记录
      this.errorHistory = []
      this.g1g2DiffHistory = []
      app.sendCommand('START:' + this.data.speed)
    } else {
      console.log('[Experiment] 发送STOP停止电机（图像流继续）')
      app.sendCommand('STOP')
    }
  },

  onSaveChart() {
    const data = this.errorHistory
    if (data.length === 0) {
      wx.showToast({ title: '无数据可保存', icon: 'none' })
      return
    }

    wx.showLoading({ title: '正在生成图表...' })

    const width = 1800
    const height = 1000
    const padL = 80, padR = 50, padT = 60, padB = 70

    const canvas = wx.createOffscreenCanvas({ type: '2d', width, height })
    const ctx = canvas.getContext('2d')

    // 背景
    ctx.fillStyle = '#1a1a1a'
    ctx.fillRect(0, 0, width, height)

    const chartW = width - padL - padR
    const chartH = height - padT - padB

    // ===== 自适应Y轴范围 =====
    const absMax = Math.max(...data.map(Math.abs), 1)
    let yMax = absMax <= 10 ? 10 : (absMax <= 20 ? 20 : (absMax <= 40 ? 40 : (absMax <= 80 ? 80 : Math.ceil(absMax / 20) * 20)))

    // 标题
    ctx.font = 'bold 34px monospace'
    ctx.fillStyle = '#9C27B0'
    ctx.textAlign = 'center'
    ctx.fillText('PID Error Curve', width / 2, 38)

    // 绘图区域边框
    ctx.strokeStyle = '#444'
    ctx.lineWidth = 2
    ctx.strokeRect(padL, padT, chartW, chartH)

    // ===== 网格线 =====
    // 水平网格（9条线=8等分）
    const hSteps = 8
    for (let i = 0; i <= hSteps; i++) {
      const y = padT + (i / hSteps) * chartH
      const isCenter = (i === hSteps / 2)
      const isEdge = (i === 0 || i === hSteps)
      ctx.beginPath()
      ctx.strokeStyle = isCenter ? '#999' : (isEdge ? '#888' : '#666')
      ctx.lineWidth = isCenter ? 1.5 : (isEdge ? 1 : 0.5)
      ctx.setLineDash(isCenter ? [8, 6] : [])
      ctx.moveTo(padL, y)
      ctx.lineTo(padL + chartW, y)
      ctx.stroke()
      ctx.setLineDash([])

      // Y轴刻度标签（每条线都标，更细密）
      const val = yMax - (i / hSteps) * 2 * yMax
      ctx.font = (isCenter || isEdge) ? '22px monospace' : '18px monospace'
      ctx.fillStyle = isCenter ? '#eee' : (isEdge ? '#ccc' : '#999')
      ctx.textAlign = 'right'
      ctx.fillText((val >= 0 ? '+' : '') + val.toFixed(0), padL - 12, y + 7)
    }

    // 垂直网格（11条线=10等分）
    const vSteps = 10
    for (let i = 0; i <= vSteps; i++) {
      const x = padL + (i / vSteps) * chartW
      const isMajor = (i % 5 === 0)
      ctx.beginPath()
      ctx.strokeStyle = isMajor ? '#666' : '#444'
      ctx.lineWidth = isMajor ? 0.8 : 0.6
      ctx.moveTo(x, padT)
      ctx.lineTo(x, padT + chartH)
      ctx.stroke()

      // 每条线都显示X轴标签
      ctx.font = isMajor ? '18px monospace' : '15px monospace'
      ctx.fillStyle = isMajor ? '#aaa' : '#777'
      ctx.textAlign = 'center'
      ctx.fillText(Math.round(i / vSteps * data.length), x, height - 22)
    }
    
    // X轴标签
    ctx.font = '20px monospace'
    ctx.fillStyle = '#888'
    ctx.textAlign = 'center'
    ctx.fillText('Frame →', padL + chartW / 2, height - 4)

    // 全部数据绘制（自适应Y轴）
    const maxPts = data.length
    ctx.beginPath()
    ctx.strokeStyle = '#00CC88'
    ctx.lineWidth = 3
    for (let i = 0; i < data.length; i++) {
      const x = padL + (i / Math.max(maxPts - 1, 1)) * chartW
      const val = data[i]
      const y = padT + chartH / 2 - (val / yMax) * (chartH / 2)
      if (i === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    }
    ctx.stroke()

    // 当前值标记
    if (data.length > 0) {
      const lastVal = data[data.length - 1]
      const lastX = padL + ((data.length - 1) / Math.max(maxPts - 1, 1)) * chartW
      const lastY = padT + chartH / 2 - (lastVal / yMax) * (chartH / 2)

      ctx.beginPath()
      ctx.arc(lastX, lastY, 8, 0, 2 * Math.PI)
      ctx.fillStyle = '#00FFAA'
      ctx.fill()

      ctx.font = 'bold 26px monospace'
      ctx.fillStyle = '#00FFAA'
      ctx.textAlign = 'left'
      ctx.fillText(lastVal.toFixed(1), lastX + 14, lastY + 9)
    }

    // 底部统计信息
    const mean = data.reduce((a, b) => a + b, 0) / data.length
    let variance = 0
    for (let v of data) variance += (v - mean) ** 2
    const stdDev = Math.sqrt(variance / data.length)
    const minE = Math.min(...data)
    const maxE = Math.max(...data)
    
    ctx.font = '20px monospace'
    ctx.fillStyle = '#888'
    ctx.textAlign = 'left'
    ctx.fillText(`N=${data.length}  Mean=${mean.toFixed(1)}  Std=${stdDev.toFixed(1)}  Min=${minE}  Max=${maxE}  YRange=[-${yMax},+${yMax}]`,
                 padL, height - 18)

    // 保存到相册
    wx.canvasToTempFilePath({
      canvas,
      success: (res) => {
        wx.hideLoading()
        wx.saveImageToPhotosAlbum({
          filePath: res.tempFilePath,
          success: () => {
            wx.showToast({ title: '已保存到相册', icon: 'success' })
          },
          fail: () => {
            wx.showToast({ title: '保存失败', icon: 'none' })
          }
        })
      },
      fail: () => {
        wx.hideLoading()
        wx.showToast({ title: '生成失败', icon: 'none' })
      }
    })
  },

  onSpeedUp() {
    if (this.data.speed >= 100) return
    const speed = this.data.speed + 1
    this.setData({ speed })
    if (this.data.running && !this.data.debugMode) {
      app.sendCommand('SPEED:' + speed)
    }
  },

  onSpeedDown() {
    if (this.data.speed <= 0) return
    const speed = this.data.speed - 1
    this.setData({ speed })
    if (this.data.running && !this.data.debugMode) {
      app.sendCommand('SPEED:' + speed)
    }
  },

  onKpUp() {
    if (this.data.kp >= 5.0) return
    const kp = parseFloat((this.data.kp + 0.05).toFixed(2))
    this.setData({ kp })
    if (!this.data.debugMode) {
      app.sendCommand('KP:' + kp.toFixed(2))
    }
  },

  onKpDown() {
    if (this.data.kp <= 0) return
    const kp = parseFloat((this.data.kp - 0.05).toFixed(2))
    this.setData({ kp })
    if (!this.data.debugMode) {
      app.sendCommand('KP:' + kp.toFixed(2))
    }
  },

  generateDebugImage() {
    // 调试模式：生成左侧灰度渐变（原图模拟）+ 右侧二值图（预测结果模拟）+ 示例引导线叠加
    const width = 320
    const height = 120
    const rgbaData = new Uint8ClampedArray(width * height * 4)
    
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4
        let gray
        if (x < 160) {
          gray = Math.floor((x / 160) * 255)
        } else {
          if (x >= 220 && x <= 260 && y >= 20 && y <= 100) {
            gray = 255
          } else {
            gray = 0
          }
        }
        rgbaData[i] = gray
        rgbaData[i + 1] = gray
        rgbaData[i + 2] = gray
        rgbaData[i + 3] = 255
      }
    }
    
    const canvas = wx.createOffscreenCanvas({ type: '2d', width, height })
    const ctx = canvas.getContext('2d')
    const imgData = ctx.createImageData(width, height)
    imgData.data.set(rgbaData)
    ctx.putImageData(imgData, 0, 0)

    const offsetX = 160
    const targetX = 80, guideX = 75

    ctx.beginPath()
    ctx.setLineDash([4, 4])
    ctx.moveTo(offsetX + 10, 60)
    ctx.lineTo(offsetX + 150, 60)
    ctx.moveTo(offsetX + 80, 10)
    ctx.lineTo(offsetX + 80, 110)
    ctx.strokeStyle = '#00CC00'
    ctx.lineWidth = 1
    ctx.stroke()
    ctx.setLineDash([])

    ctx.beginPath()
    ctx.arc(offsetX + targetX, 60, 5, 0, 2 * Math.PI)
    ctx.strokeStyle = '#00FF00'
    ctx.lineWidth = 2
    ctx.stroke()

    ctx.beginPath()
    ctx.moveTo(offsetX + targetX, 60)
    ctx.lineTo(offsetX + guideX, 60)
    ctx.strokeStyle = '#00FF00'
    ctx.lineWidth = 2
    ctx.stroke()

    const errorPx = targetX - guideX
    const midX = offsetX + (targetX + guideX) / 2
    ctx.font = 'bold 11px monospace'
    ctx.fillStyle = '#00FF00'
    ctx.textAlign = 'center'
    ctx.fillText(errorPx + 'px', midX, 60 - 8)

    ctx.beginPath()
    ctx.arc(offsetX + guideX, 60, 4, 0, 2 * Math.PI)
    ctx.fillStyle = '#CC88FF'
    ctx.fill()
    
    wx.canvasToTempFilePath({
      canvas,
      success: (res) => {
        this.setData({ imageData: res.tempFilePath })
      }
    })
  }
})
