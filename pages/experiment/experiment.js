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
  FRAME_HEADER_SIZE: 6,     // 帧头: [帧号2B][电压1B][左PWM1B][右PWM1B][引导线x1B] + 补1B=6
  FRAME_IMAGE_SIZE: 19200,  // 图像数据: 160x120
  FRAME_PACKET_SIZE: 19206, // 每帧总大小

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
      console.log('[Experiment] 图像通道就绪，发送START启动电机')
      this.setData({ streaming: true })
      // 图像通道OK后立即启动电机
      app.sendCommand('START:' + this.data.speed)
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
      const motorA = Math.round(frameBytes[3] * 100 / 255)
      const motorB = Math.round(frameBytes[4] * 100 / 255)
      const guide_x = frameBytes[5]
      
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
      this.processImage(grayData, { guide_x: guide_x }, Date.now())
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

    // ========== 绘制PID目标点和引导线 ==========
    if (pidData) {
      const guide_x = pidData.guide_x
      const target_x = 80, cy = 60
      
      ctx.beginPath()
      ctx.setLineDash([4, 4])
      ctx.moveTo(10, cy); ctx.lineTo(150, cy)
      ctx.moveTo(80, 10); ctx.lineTo(80, 110)
      ctx.strokeStyle = '#00CC00'; ctx.lineWidth = 1
      ctx.stroke()
      ctx.setLineDash([])
      
      ctx.beginPath()
      ctx.arc(target_x, cy, 5, 0, 2 * Math.PI)
      ctx.strokeStyle = '#00FF00'; ctx.lineWidth = 2
      ctx.stroke()
      
      ctx.beginPath()
      ctx.moveTo(target_x, cy); ctx.lineTo(guide_x, cy)
      ctx.strokeStyle = '#00FF00'; ctx.lineWidth = 2
      ctx.stroke()
      
      ctx.font = 'bold 11px monospace'
      ctx.fillStyle = '#00FF00'
      ctx.textAlign = 'center'
      ctx.fillText((target_x - guide_x) + 'px', (target_x + guide_x) / 2, cy - 8)
      
      ctx.beginPath()
      ctx.arc(guide_x, cy, 4, 0, 2 * Math.PI)
      ctx.fillStyle = '#CC88FF'
      ctx.fill()
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
      app.sendCommand('START:' + this.data.speed)
    } else {
      console.log('[Experiment] 发送STOP停止电机（图像流继续）')
      app.sendCommand('STOP')
    }
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
