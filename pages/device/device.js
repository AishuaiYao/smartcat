const app = getApp()

Page({
  data: {
    connected: false,
    connecting: true,
    deviceName: '',
    debugMode: false,
    capturing: false,
    imageData: null,
    savedImages: [],
    imageCount: 0,
    progress: 0,
    logMsgs: []
  },

  receiveBuffer: null,
  expectedLength: 0,
  receiveOffset: 0,
  chunkCount: 0,
  headerBuffer: [],

  log(msg) {
    const time = new Date().toLocaleTimeString()
    console.log('[Device] ' + time + ' ' + msg)
    const msgs = this.data.logMsgs
    msgs.unshift(time + ' | ' + msg)
    if (msgs.length > 50) msgs.pop()
    this.setData({ logMsgs: msgs })
  },

  onLoad(options) {
    const deviceName = options.name || '未知设备'
    const debugMode = options.debug === '1'
    this.setData({ deviceName, debugMode })
    wx.setNavigationBarTitle({ title: deviceName })
    this.log('页面加载: ' + deviceName + (debugMode ? ' [调试模式]' : ''))
    this.loadSavedImages()
    if (!debugMode) {
      this.registerCallbacks()
      this.connectDevice()
    } else {
      this.setData({ connected: true, connecting: false })
    }
  },

  onShow() {
    this.log('页面显示')
    this.setData({ connected: app.globalData.connected })
    this.loadSavedImages()
    if (!this.data.debugMode && !this.onMessageBound) {
      this.registerCallbacks()
    }
  },

  onUnload() {
    this.log('页面卸载')
    this.removeCallbacks()
    app.disconnectTCP()
  },

  loadSavedImages() {
    const images = wx.getStorageSync('savedImages') || []
    this.log('加载本地图片: ' + images.length + ' 张')
    this.setData({ savedImages: images, imageCount: images.length })
  },

  connectDevice() {
    this.log('>>> 开始连接 ' + app.globalData.esp32IP + ':' + app.globalData.esp32Port)

    app.connectTCP((success) => {
      if (!success) {
        this.log('!!! 连接失败')
        this.setData({ connecting: false })
        wx.showModal({ title: '连接失败', content: '无法创建Socket', showCancel: false, complete: () => wx.navigateBack() })
      }
    })
  },

  onMessage(res) {
    const bytes = new Uint8Array(res.message)
    if (!this.data.connected) {
      const info = String.fromCharCode(...bytes).trim()
      this.log('<<< 握手响应: ' + info)
      app.setConnected(true)
      this.setData({ connected: true, connecting: false })
      return
    }
    this.log('<<< 收到数据包: ' + bytes.length + ' 字节')
    this.onReceiveData(res.message)
  },

  onClose() {
    this.log('<<< 连接已关闭')
    this.setData({ connected: false, capturing: false })
  },

  onError(err) {
    this.log('!!! 连接错误: ' + JSON.stringify(err))
    this.setData({ connected: false, connecting: false })
    wx.showModal({ title: '连接失败', content: '无法连接设备', showCancel: false, complete: () => wx.navigateBack() })
  },

  captureImage() {
    this.log('>>> captureImage 调用, connected=' + this.data.connected + ', capturing=' + this.data.capturing)

    if (!this.data.connected) {
      this.log('!!! 未连接ESP32，无法拍照')
      wx.showToast({ title: '请先连接ESP32', icon: 'none' })
      return
    }

    if (this.data.capturing) {
      this.log('!!! 正在采集中，请等待')
      return
    }

    this.setData({ capturing: true, progress: 0 })
    this.receiveBuffer = null
    this.receiveOffset = 0
    this.expectedLength = 0
    this.chunkCount = 0
    this.headerBuffer = []

    this.log('>>> 发送CAPTURE命令')
    app.sendCommand('CAPTURE')
  },

  onReceiveData(data) {
    const bytes = new Uint8Array(data)
    let offset = 0

    while (offset < bytes.length) {
      if (!this.receiveBuffer) {
        while (this.headerBuffer.length < 4 && offset < bytes.length) {
          this.headerBuffer.push(bytes[offset++])
        }
        if (this.headerBuffer.length < 4) return

        this.expectedLength = (this.headerBuffer[0] << 24) | (this.headerBuffer[1] << 16) | (this.headerBuffer[2] << 8) | this.headerBuffer[3]
        this.headerBuffer = []
        this.receiveBuffer = new Uint8Array(this.expectedLength)
        this.receiveOffset = 0
        this.chunkCount = 0
        this.log('    帧头: 预期图像=' + this.expectedLength + ' 字节')
      }

      const remaining = bytes.length - offset
      const toWrite = Math.min(remaining, this.expectedLength - this.receiveOffset)
      this.receiveBuffer.set(bytes.subarray(offset, offset + toWrite), this.receiveOffset)
      this.receiveOffset += toWrite
      offset += toWrite
      this.chunkCount++

      const progress = Math.floor((this.receiveOffset / this.expectedLength) * 100)
      this.setData({ progress })

      if (this.receiveOffset >= this.expectedLength) {
        this.log('<<< 图像接收完成! 共' + this.chunkCount + '包, ' + this.receiveOffset + '字节')
        this.processImage(this.receiveBuffer)
        this.receiveBuffer = null
        this.receiveOffset = 0
        this.chunkCount = 0
        this.setData({ capturing: false, progress: 0 })
      }
    }
  },

  processImage(grayData) {
    this.log('>>> 处理图像, 长度=' + grayData.length)
    const width = grayData.length === 38400 ? 320 : 160
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

    this.log('>>> Canvas绘制完成, 导出临时文件')
    wx.canvasToTempFilePath({
      canvas,
      success: (res) => {
        this.log('<<< 导出成功: ' + res.tempFilePath)
        this.setData({ imageData: res.tempFilePath })
        wx.showToast({ title: '采集成功', icon: 'success' })
      },
      fail: (err) => {
        this.log('!!! 导出失败: ' + JSON.stringify(err))
      }
    })
  },

  removeCallbacks() {
    app.removeMessageCallback(this.onMessageBound)
    app.removeCloseCallback(this.onCloseBound)
    app.removeErrorCallback(this.onErrorBound)
  },

  registerCallbacks() {
    this.onMessageBound = this.onMessage.bind(this)
    this.onCloseBound = this.onClose.bind(this)
    this.onErrorBound = this.onError.bind(this)
    app.addMessageCallback(this.onMessageBound)
    app.addCloseCallback(this.onCloseBound)
    app.addErrorCallback(this.onErrorBound)
  },

  goToAlbum() {
    this.log('>>> 打开本地相册')
    wx.navigateTo({ url: '/pages/album/album?debug=' + (this.data.debugMode ? '1' : '0') })
  },

  goToCollect() {
    this.log('>>> 跳转数据采集页面')
    wx.navigateTo({ url: '/pages/collect/collect' })
  }
})
