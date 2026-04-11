const app = getApp()

Page({
  data: {
    imageData: null,
    frameCount: 0,
    streaming: false,
    fps: 0,
    debugMode: false,
    running: false,
    speed: 10,
    savedCount: 0,
    isCollecting: false
  },

  lastFrameTime: 0,
  udpSocket: null,
  udpLocalPort: 5001,
  frameBuffer: null,
  frameSize: 19200,

  onLoad(options) {
    console.log('[Collect] ========== 页面加载 ==========')
    console.log('[Collect] debug=' + options.debug + ', connected=' + app.globalData.connected)
    
    if (options.debug === '1') {
      this.setData({ debugMode: true, streaming: true })
      this.generateDebugImage()
      return
    }
    
    if (!app.globalData.connected) {
      console.log('[Collect] !!! 设备未连接，返回')
      wx.showToast({ title: '设备未连接', icon: 'none' })
      wx.navigateBack()
      return
    }
    
    console.log('[Collect] 注册回调，初始化UDP')
    this.registerCallbacks()
    this.setupUDP()
  },

  onUnload() {
    console.log('[Collect] 页面卸载')
    this.removeCallbacks()
    
    if (this.udpSocket) {
      app.sendCommand('STOP')
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
    console.log('[Collect] TCP消息: ' + str)
    
    if (str.includes('UDP_OK')) {
      console.log('[Collect] UDP就绪，发送STREAM')
      app.sendCommand('STREAM')
      this.setData({ streaming: true })
      return
    }
    
    if (str.includes('UDP_NOT_READY')) {
      console.log('[Collect] UDP未就绪')
      wx.showToast({ title: 'UDP初始化失败', icon: 'none' })
    }
  },

  onClose() {
    console.log('[Collect] TCP连接已关闭')
    this.setData({ streaming: false })
  },

  onError(err) {
    console.log('[Collect] TCP连接错误:', err)
    wx.showToast({ title: '连接断开', icon: 'none' })
    this.setData({ streaming: false })
  },

  setupUDP() {
    console.log('========== UDP初始化 ==========')
    
    const udp = wx.createUDPSocket()
    if (!udp) {
      console.log('[Collect] 创建UDP失败')
      wx.showToast({ title: 'UDP创建失败', icon: 'none' })
      return
    }
    this.udpSocket = udp
    app.setUDPSocket(udp)

    udp.onMessage((res) => {
      this.onReceiveUDPData(res.message)
    })

    udp.onError((err) => {
      console.log('[Collect] UDP错误:', err)
    })

    const port = udp.bind(this.udpLocalPort)
    console.log('[Collect] UDP绑定端口: ' + port)
    console.log('================================')
    
    app.sendCommand('UDP_HELLO:' + port)
    
    const helloMsg = 'HELLO_UDP'
    udp.send({
      address: app.globalData.esp32IP,
      port: 5001,
      message: helloMsg
    })
    console.log('[Collect] 发送HELLO_UDP到ESP32')
  },

  onReceiveUDPData(data) {
    const bytes = new Uint8Array(data)
    if (bytes.length < 4) {
      console.log('[UDP] 数据太短:', bytes.length)
      return
    }
    
    // 解析分片协议头
    const frameNum = (bytes[0] << 8) | bytes[1]    // 帧号
    const totalChunks = bytes[2]                    // 总分片数
    const chunkIndex = bytes[3]                     // 当前分片索引
    const chunkData = bytes.slice(4)                // 分片数据
    
    // 初始化或切换帧缓冲区
    if (!this.frameBuffer || this.frameBuffer.frameNum !== frameNum) {
      // 如果是新一帧，初始化缓冲区
      this.frameBuffer = {
        frameNum: frameNum,
        totalChunks: totalChunks,
        chunks: new Array(totalChunks),
        receivedCount: 0,
        startTime: Date.now()
      }
    }
    
    // 存储分片
    if (!this.frameBuffer.chunks[chunkIndex]) {
      this.frameBuffer.chunks[chunkIndex] = chunkData
      this.frameBuffer.receivedCount++
    }
    
    // 检查是否收齐所有分片
    if (this.frameBuffer.receivedCount === this.frameBuffer.totalChunks) {
      // 组装完整帧
      const grayData = this.assembleFrame()
      if (grayData) {
        // 计算帧率
        const now = Date.now()
        if (this.lastFrameTime > 0) {
          const delta = now - this.lastFrameTime
          const fps = delta > 0 ? Math.round(1000 / delta) : 0
          this.setData({ fps })
        }
        this.lastFrameTime = now
        
        // 更新帧计数
        const frameCount = this.data.frameCount + 1
        this.setData({ frameCount })
        
        // 每10帧打印一次状态
        if (frameCount % 10 === 0) {
          const assembleTime = Date.now() - this.frameBuffer.startTime
          console.log('[UDP] 帧' + frameCount + ': 组装完成, 耗时' + assembleTime + 'ms, FPS=' + this.data.fps)
        }
        
        // 处理图像
        this.processImage(grayData)
      }
      
      // 清空缓冲区
      this.frameBuffer = null
    }
  },

  assembleFrame() {
    if (!this.frameBuffer || this.frameBuffer.receivedCount !== this.frameBuffer.totalChunks) {
      return null
    }
    
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

  processImage(grayData) {
    const startTime = Date.now()
    
    const width = 160
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

    const frameCount = this.data.frameCount

    wx.canvasToTempFilePath({
      canvas,
      success: (res) => {
        this.setData({ imageData: res.tempFilePath })
        const processTime = Date.now() - startTime
        
        if (frameCount % 10 === 0) {
          console.log('[Render] 帧' + frameCount + ': 渲染完成, 耗时' + processTime + 'ms')
        }
        
        if (frameCount % 10 === 1 && !this.data.debugMode && this.data.isCollecting) {
          this.saveImage(res.tempFilePath)
        }
      }
    })
  },

  saveImage(tempFilePath) {
    let images = wx.getStorageSync('savedImages') || []
    if (images.length >= 500) {
      console.log('[Save] 已达500张上限，跳过保存')
      return
    }

    wx.saveFile({
      tempFilePath,
      success: (res) => {
        images.unshift({
          path: res.savedFilePath,
          time: new Date().toLocaleString(),
          uploaded: false
        })
        wx.setStorageSync('savedImages', images)
        const savedCount = this.data.savedCount + 1
        this.setData({ savedCount })
        console.log('[Save] 已保存第' + savedCount + '幅图像到缓存，共' + images.length + '张')
      },
      fail: (err) => {
        console.log('[Save] 保存失败:', err)
      }
    })
  },

  onLeft() {
    console.log('[Collect] >>> 左转按钮')
    if (this.data.debugMode) return
    app.sendCommand('MOTOR_LEFT')
  },

  onRight() {
    console.log('[Collect] >>> 右转按钮')
    if (this.data.debugMode) return
    app.sendCommand('MOTOR_RIGHT')
  },

  onStop() {
    console.log('[Collect] >>> 停止按钮')
    if (this.data.debugMode) return
    app.sendCommand('MOTOR_STOP')
  },

  onStartStop() {
    const running = !this.data.running
    this.setData({ running })
    if (this.data.debugMode) return
    if (running) {
      app.sendCommand('START')
      app.sendCommand('SPEED:' + this.data.speed)
      this.setData({ isCollecting: true })
    } else {
      app.sendCommand('MOTOR_STOP')
      this.setData({ isCollecting: false })
    }
  },

  onSpeedChange(e) {
    const speed = e.detail.value
    this.setData({ speed })
    if (this.data.debugMode) return
    if (this.data.running) {
      app.sendCommand('SPEED:' + speed)
    }
  },

  generateDebugImage() {
    const width = 160
    const height = 120
    const rgbaData = new Uint8ClampedArray(width * height * 4)
    
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const i = (y * width + x) * 4
        const gray = Math.floor((x / width) * 255)
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
    
    wx.canvasToTempFilePath({
      canvas,
      success: (res) => {
        this.setData({ imageData: res.tempFilePath })
      }
    })
  }
})
