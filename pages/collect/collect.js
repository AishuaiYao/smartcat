Page({
  data: {
    imageData: null,
    frameCount: 0,
    streaming: false,
    fps: 0,
    debugMode: false,
    running: false,
    speed: 5
  },

  // 帧率计算
  lastFrameTime: 0,

  tcpSocket: null,
  udpSocket: null,
  esp32IP: '192.168.4.1',
  esp32Port: 5000,
  udpLocalPort: 5001,
  
  // 帧缓冲区管理
  frameBuffer: null,         // 当前帧缓冲区 { frameNum, totalChunks, chunks[], receivedCount }
  frameSize: 19200,          // 160x120 灰度图

  onLoad(options) {
    // 调试模式
    if (options.debug === '1') {
      this.setData({ debugMode: true, streaming: true })
      this.generateDebugImage()
      return
    }
    this.connectDevice()
  },

  onUnload() {
    this.disconnect()
  },

  connectDevice() {
    // 创建TCP连接
    const socket = wx.createTCPSocket()
    if (!socket) {
      wx.showToast({ title: '连接失败', icon: 'none' })
      wx.navigateBack()
      return
    }
    this.tcpSocket = socket

    socket.onConnect(() => {
      console.log('[Collect] TCP连接成功，发送HELLO')
      socket.write('HELLO\n')
    })

    socket.onMessage((res) => {
      const bytes = new Uint8Array(res.message)
      const str = String.fromCharCode(...bytes.subarray(0, Math.min(bytes.length, 50)))
      console.log('[Collect] TCP消息: ' + str)
      
      // 处理握手响应
      if (str.includes('LinePatrol') || str.includes('|')) {
        console.log('[Collect] 握手成功，创建UDP')
        this.setupUDP()
        return
      }
      
      // 处理UDP_OK响应
      if (str.includes('UDP_OK')) {
        console.log('[Collect] UDP就绪，发送STREAM')
        this.sendCommand('STREAM')
        this.setData({ streaming: true })
        return
      }
      
      // 处理错误
      if (str.includes('UDP_NOT_READY')) {
        console.log('[Collect] UDP未就绪')
        wx.showToast({ title: 'UDP初始化失败', icon: 'none' })
      }
    })

    socket.onClose(() => {
      console.log('[Collect] TCP连接已关闭')
      this.setData({ streaming: false })
    })

    socket.onError((err) => {
      console.log('[Collect] TCP连接错误:', err)
      wx.showToast({ title: '连接断开', icon: 'none' })
      this.setData({ streaming: false })
    })

    socket.connect({ address: this.esp32IP, port: this.esp32Port })
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

    udp.onMessage((res) => {
      const { message } = res
      this.onReceiveUDPData(message)
    })

    udp.onError((err) => {
      console.log('[Collect] UDP错误:', err)
    })

    // 绑定本地端口
    const port = udp.bind(this.udpLocalPort)
    console.log('[Collect] UDP绑定端口: ' + port)
    console.log('================================')
    
    // 发送UDP_HELLO告知ESP32
    this.sendCommand('UDP_HELLO:' + port)
    
    // 发送一个UDP包让ESP32知道客户端地址
    const helloMsg = 'HELLO_UDP'
    udp.send({
      address: this.esp32IP,
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
    
    // 组装所有分片
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

  disconnect() {
    console.log('========== 断开连接 ==========')
    
    if (this.tcpSocket) {
      console.log('[TCP] 发送STOP命令')
      this.sendCommand('STOP')
      console.log('[TCP] 关闭连接')
      this.tcpSocket.close()
      this.tcpSocket = null
    }
    if (this.udpSocket) {
      console.log('[UDP] 关闭Socket')
      this.udpSocket.close()
      this.udpSocket = null
    }
    
    // 清空缓冲区
    this.frameBuffer = null
    
    console.log('[统计] 总帧数:', this.data.frameCount)
    console.log('================================')
  },

  sendCommand(cmd) {
    if (!this.tcpSocket) return
    const msg = cmd + '\n'
    const buffer = new ArrayBuffer(msg.length)
    const view = new Uint8Array(buffer)
    for (let i = 0; i < msg.length; i++) {
      view[i] = msg.charCodeAt(i)
    }
    this.tcpSocket.write(buffer)
    console.log('[Collect] 发送命令: ' + cmd)
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
        
        // 每10帧打印一次处理耗时
        if (frameCount % 10 === 0) {
          console.log('[Render] 帧' + frameCount + ': 渲染完成, 耗时' + processTime + 'ms')
        }
      }
    })
  },

  onLeft() {
    if (this.data.debugMode) return
    this.sendCommand('MOTOR_LEFT')
  },

  onRight() {
    if (this.data.debugMode) return
    this.sendCommand('MOTOR_RIGHT')
  },

  onStop() {
    if (this.data.debugMode) return
    this.sendCommand('MOTOR_STOP')
  },

  onStartStop() {
    const running = !this.data.running
    this.setData({ running })
    if (this.data.debugMode) return
    this.sendCommand(running ? 'START' : 'STOP')
  },

  onSpeedChange(e) {
    const speed = e.detail.value
    this.setData({ speed })
    if (this.data.debugMode) return
    this.sendCommand('SPEED:' + speed)
  },

  generateDebugImage() {
    const width = 160
    const height = 120
    const rgbaData = new Uint8ClampedArray(width * height * 4)
    
    // 生成渐变测试图案
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
