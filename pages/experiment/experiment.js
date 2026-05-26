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
  udpSocket: null,
  udpLocalPort: 5003,
  frameBuffer: null,
  frameSize: 19200,  // 叠加图：160x120 = 19200
  totalChunks: 3,
  chunkDataSize: 6400,


  onLoad(options) {
    console.log('[Experiment] ========== 页面加载 ==========')
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
    
    console.log('[Experiment] 注册回调，初始化UDP')
    this.registerCallbacks()
    this.setupUDP()
  },

  onUnload() {
    console.log('[Experiment] 页面卸载')
    this.removeCallbacks()
    
    if (this.udpSocket) {
      app.sendCommand('STOP_EXPERIMENT')
      this.udpSocket.close()
      this.udpSocket = null
    }
    this.frameBuffer = null
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
    
    if (str.includes('UDP_OK')) {
      console.log('[Experiment] UDP就绪，发送EXPERIMENT')
      app.sendCommand('EXPERIMENT')
      this.setData({ streaming: true })
      return
    }
    
    if (str.includes('UDP_NOT_READY')) {
      console.log('[Experiment] UDP未就绪')
      wx.showToast({ title: 'UDP初始化失败', icon: 'none' })
    }
  },

  onClose() {
    console.log('[Experiment] TCP连接已关闭')
    this.setData({ streaming: false })
  },

  onError(err) {
    console.log('[Experiment] TCP连接错误:', err)
    wx.showToast({ title: '连接断开', icon: 'none' })
    this.setData({ streaming: false })
  },

  setupUDP() {
    console.log('========== UDP初始化 ==========')
    
    const udp = wx.createUDPSocket()
    if (!udp) {
      console.log('[Experiment] 创建UDP失败')
      wx.showToast({ title: 'UDP创建失败', icon: 'none' })
      return
    }
    this.udpSocket = udp
    app.setUDPSocket(udp)

    udp.onMessage((res) => {
      this.onReceiveUDPData(res.message)
    })

    udp.onError((err) => {
      console.log('[Experiment] UDP错误:', err)
    })

    const port = udp.bind(this.udpLocalPort)
    console.log('[Experiment] UDP绑定端口: ' + port)
    console.log('================================')
    
    app.sendCommand('UDP_HELLO:' + port)
    
    const helloMsg = 'HELLO_UDP'
    udp.send({
      address: app.globalData.esp32IP,
      port: 5001,
      message: helloMsg
    })
    console.log('[Experiment] 发送HELLO_UDP到ESP32')
  },

  lastMsgTime: 0,  // 上一次onMessage触发时间

  onReceiveUDPData(data) {
    const t0 = Date.now()

    // [诊断] 距上次onMessage的间隔（定位大间隔发生位置）
    if (this.lastMsgTime > 0) {
      const gap = t0 - this.lastMsgTime
      if (gap > 200) {
        console.log('[GAP] onMessage空闲+' + gap + 'ms')
      }
    }
    this.lastMsgTime = t0

    const bytes = new Uint8Array(data)
    if (bytes.length < 4) {
      console.log('[UDP] 数据太短:', bytes.length)
      return
    }

    const frameNum = (bytes[0] << 8) | bytes[1]
    const totalChunks = bytes[2]
    const chunkIndex = bytes[3]
    let chunkData
    
    if (chunkIndex === 0 && bytes.length >= 8) {
      const voltageRaw = bytes[4]
      const voltage = (voltageRaw / 10).toFixed(1)
      const motorA = Math.round(bytes[5] * 100 / 255)
      const motorB = Math.round(bytes[6] * 100 / 255)
      this.setData({ voltage, motorA, motorB })
      this._pidData = { guide_x: bytes[7] }
      chunkData = bytes.slice(8)
    } else {
      chunkData = bytes.slice(4)
    }

    // 初始化或切换帧缓冲区
    const now = Date.now()
    if (!this.frameBuffer || this.frameBuffer.frameNum !== frameNum) {
      this.frameBuffer = {
        frameNum: frameNum,
        totalChunks: totalChunks,
        chunks: new Array(totalChunks),
        receivedCount: 0,
        startTime: now
      }
    }

    // 存储分片
    if (!this.frameBuffer.chunks[chunkIndex]) {
      this.frameBuffer.chunks[chunkIndex] = chunkData
      this.frameBuffer.receivedCount++
      console.log('[Chunk] 帧' + frameNum + ' 片' + (chunkIndex + 1) + '/' + totalChunks + ', 距首片+' + (now - this.frameBuffer.startTime) + 'ms')
    }

    // 检查是否收齐所有分片
    if (this.frameBuffer.receivedCount === this.frameBuffer.totalChunks) {
      const tAssembleStart = Date.now()
      const grayData = this.assembleFrame()
      const tAssembleEnd = Date.now()
      
      if (grayData) {
        // 计算帧间隔
        const now = Date.now()
        if (this.lastFrameTime > 0) {
          const delta = now - this.lastFrameTime
          this.setData({ delayMs: delta < 2000 ? delta : 0 })
        }
        this.lastFrameTime = now
        
        const frameCount = this.data.frameCount + 1
        this.setData({ frameCount })

        const assembleCost = tAssembleEnd - tAssembleStart
        const fromFirstChunk = tAssembleEnd - this.frameBuffer.startTime
        console.log('[Assemble] 帧' + frameCount + '(ESP32帧' + frameNum + '): 组装耗时' + assembleCost + 'ms, 距首片' + fromFirstChunk + 'ms, 帧间隔' + this.data.delayMs + 'ms')

        // 处理图像
        this.processImage(grayData, this._pidData, tAssembleEnd)
        this._pidData = null
      }

      this.frameBuffer = null
    }
  },

  assembleFrame() {
    if (!this.frameBuffer) return null
    
    const grayData = new Uint8Array(this.frameSize)
    let offset = 0
    
    for (let i = 0; i < this.frameBuffer.totalChunks; i++) {
      const chunk = this.frameBuffer.chunks[i]
      if (chunk) {
        grayData.set(chunk, offset)
        offset += chunk.length
      }
    }
    
    return grayData
  },

  processImage(grayData, pidData, tAssembleEnd) {
    const t0 = Date.now()
    console.log('[Process] 进入processImage, 距组装完成+' + (t0 - tAssembleEnd) + 'ms')
    
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
      app.sendCommand('START:' + this.data.speed)
    } else {
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
          // 左侧：灰度渐变模拟原图
          gray = Math.floor((x / 160) * 255)
        } else {
          // 右侧：黑白二值模拟预测结果（中间白色竖条模拟引导线）
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

    // 示例目标点和引导点叠加
    const offsetX = 160
    const targetX = 80, guideX = 75

    // 中心十字线（绿色虚线）
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

    // 目标点（绿色空心）
    ctx.beginPath()
    ctx.arc(offsetX + targetX, 60, 5, 0, 2 * Math.PI)
    ctx.strokeStyle = '#00FF00'
    ctx.lineWidth = 2
    ctx.stroke()

    // 偏差连线
    ctx.beginPath()
    ctx.moveTo(offsetX + targetX, 60)
    ctx.lineTo(offsetX + guideX, 60)
    ctx.strokeStyle = '#00FF00'
    ctx.lineWidth = 2
    ctx.stroke()

    // 偏差像素值文字
    const errorPx = targetX - guideX
    const midX = offsetX + (targetX + guideX) / 2
    ctx.font = 'bold 11px monospace'
    ctx.fillStyle = '#00FF00'
    ctx.textAlign = 'center'
    ctx.fillText(errorPx + 'px', midX, 60 - 8)

    // 引导点（浅紫色实心）
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
