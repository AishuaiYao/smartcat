const app = getApp()

Page({
  data: {
    imageData: null,
    frameCount: 0,
    streaming: false,
    fps: 0,
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
  frameSize: 38400,  // 拼接图：320x120 = 38400
  totalChunks: 6,
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

  onReceiveUDPData(data) {
    const bytes = new Uint8Array(data)
    if (bytes.length < 4) {
      console.log('[UDP] 数据太短:', bytes.length)
      return
    }
    
    const frameNum = (bytes[0] << 8) | bytes[1]
    const totalChunks = bytes[2]
    const chunkIndex = bytes[3]
    let chunkData
    
    // 第一分片(0)：[协议头4B][电压1B][左PWM 1B][右PWM 1B][引导线x 1B][图像数据...]
    // 其他分片：[协议头4B][图像数据...]
    if (chunkIndex === 0 && bytes.length >= 8) {
      const voltageRaw = bytes[4]
      const voltage = (voltageRaw / 10).toFixed(1)
      const motorA = Math.round(bytes[5] * 100 / 255)
      const motorB = Math.round(bytes[6] * 100 / 255)
      this.setData({ voltage, motorA, motorB })
      // 提取 PID 引导线数据
      this._pidData = {
        guide_x: bytes[7]
      }
      chunkData = bytes.slice(8)
    } else {
      chunkData = bytes.slice(4)
    }
    
    // 初始化帧缓冲区
    if (!this.frameBuffer || this.frameBuffer.frameNum !== frameNum) {
      this.frameBuffer = {
        frameNum: frameNum,
        totalChunks: totalChunks,
        chunks: new Array(totalChunks),
        receivedCount: 0
      }
    }
    
    // 存储分片
    if (!this.frameBuffer.chunks[chunkIndex] && chunkData.length > 0) {
      this.frameBuffer.chunks[chunkIndex] = chunkData
      this.frameBuffer.receivedCount++
    }
    
    // 检查是否收齐
    if (this.frameBuffer.receivedCount === this.frameBuffer.totalChunks) {
      const grayData = this.assembleFrame()
      if (grayData && grayData.length === this.frameSize) {
        const now = Date.now()
        if (this.lastFrameTime > 0) {
          const delta = now - this.lastFrameTime
          const fps = delta > 0 ? Math.round(1000 / delta) : 0
          this.setData({ fps })
        }
        this.lastFrameTime = now
        
        const frameCount = this.data.frameCount + 1
        this.setData({ frameCount })
        
        this.processImage(grayData, this._pidData)
        this._pidData = null
      } else {
        console.log('[UDP] 组帧失败，长度:', grayData ? grayData.length : 0)
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

  processImage(grayData, pidData) {
    const startTime = Date.now()
    
    // 拼接图尺寸：320x120（左半原图 + 右半预测图）
    const width = 320
    const height = 120
    const rgbaData = new Uint8ClampedArray(width * height * 4)

    for (let i = 0; i < grayData.length; i++) {
      rgbaData[i * 4] = grayData[i]
      rgbaData[i * 4 + 1] = grayData[i]
      rgbaData[i * 4 + 2] = grayData[i]
      rgbaData[i * 4 + 3] = 255
    }

    const canvas = wx.createOffscreenCanvas({ type: '2d', width, height })
    const ctx = canvas.getContext('2d')
    const imgData = ctx.createImageData(width, height)
    imgData.data.set(rgbaData)
    ctx.putImageData(imgData, 0, 0)

    // ========== 在右侧预测图上绘制目标点和引导点 ==========
    if (pidData) {
      const offsetX = 160  // 右半预测图起始 x
      const { guide_x } = pidData
      const target_x = 80  // 图像中心，固定值
      const centerY = 60   // 图像水平中心线 y

      // 绘制中心十字线（绿色虚线）
      ctx.beginPath()
      ctx.setLineDash([4, 4])
      ctx.moveTo(offsetX + 10, centerY)
      ctx.lineTo(offsetX + 150, centerY)
      ctx.moveTo(offsetX + 80, 10)
      ctx.lineTo(offsetX + 80, 110)
      ctx.strokeStyle = '#00CC00'
      ctx.lineWidth = 1
      ctx.stroke()
      ctx.setLineDash([])

      // 绘制目标点 target（绿色空心圆）
      ctx.beginPath()
      ctx.arc(offsetX + target_x, centerY, 5, 0, 2 * Math.PI)
      ctx.strokeStyle = '#00FF00'
      ctx.lineWidth = 2
      ctx.stroke()

      // 绘制偏差连线（target → guide）
      ctx.beginPath()
      ctx.moveTo(offsetX + target_x, centerY)
      ctx.lineTo(offsetX + guide_x, centerY)
      ctx.strokeStyle = '#00FF00'
      ctx.lineWidth = 2
      ctx.stroke()

      // 绘制偏差像素值文字
      const errorPx = target_x - guide_x
      const midX = offsetX + (target_x + guide_x) / 2
      ctx.font = 'bold 11px monospace'
      ctx.fillStyle = '#00FF00'
      ctx.textAlign = 'center'
      ctx.fillText(errorPx + 'px', midX, centerY - 8)

      // 绘制引导点 guide（浅紫色实心圆）
      ctx.beginPath()
      ctx.arc(offsetX + guide_x, centerY, 4, 0, 2 * Math.PI)
      ctx.fillStyle = '#CC88FF'
      ctx.fill()
    }

    wx.canvasToTempFilePath({
      canvas,
      success: (res) => {
        this.setData({ imageData: res.tempFilePath })
        if (this.data.frameCount % 30 === 0) {
          console.log('[Render] 帧' + this.data.frameCount + ': OK, 耗时' + (Date.now() - startTime) + 'ms')
        }
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
