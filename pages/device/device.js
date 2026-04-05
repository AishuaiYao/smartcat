Page({
  data: {
    connected: false,
    connecting: true,
    deviceName: '',
    capturing: false,
    imageData: null,
    savedImages: [],
    imageCount: 0,
    progress: 0,
    logMsgs: []
  },

  socket: null,
  esp32IP: '192.168.4.1',
  esp32Port: 5000,
  receiveBuffer: null,
  expectedLength: 0,
  receiveOffset: 0,
  chunkCount: 0,
  headerBuffer: [],

  log(msg) {
    const time = new Date().toLocaleTimeString()
    console.log('[Index] ' + time + ' ' + msg)
    const msgs = this.data.logMsgs
    msgs.unshift(time + ' | ' + msg)
    if (msgs.length > 50) msgs.pop()
    this.setData({ logMsgs: msgs })
  },

  onLoad(options) {
    this.setData({ deviceName: options.name || '未知设备' })
    this.log('页面加载: ' + this.data.deviceName)
    this.loadSavedImages()
    this.connectDevice()
  },

  onShow() {
    this.log('页面显示')
    this.loadSavedImages()
  },

  onUnload() {
    this.log('页面卸载')
    this.disconnect()
  },

  loadSavedImages() {
    const images = wx.getStorageSync('savedImages') || []
    this.log('加载本地图片: ' + images.length + ' 张')
    this.setData({ savedImages: images, imageCount: images.length })
  },

  connectDevice() {
    this.log('>>> 开始连接 ' + this.esp32IP + ':' + this.esp32Port)

    const socket = wx.createTCPSocket()
    if (!socket) {
      this.log('!!! createTCPSocket 失败')
      this.setData({ connecting: false })
      wx.showModal({ title: '连接失败', content: '无法创建Socket', showCancel: false, complete: () => wx.navigateBack() })
      return
    }
    this.socket = socket
    this.log('TCPSocket 创建成功')

    socket.onConnect(() => {
      this.log('<<< TCP连接成功')
      socket.write('HELLO\n')
    })

    socket.onMessage((res) => {
      const bytes = new Uint8Array(res.message)
      if (!this.data.connected) {
        const info = String.fromCharCode(...bytes).trim()
        this.log('<<< 握手响应: ' + info)
        this.setData({ connected: true, connecting: false })
        return
      }
      this.log('<<< 收到数据包: ' + bytes.length + ' 字节')
      this.onReceiveData(res.message)
    })

    socket.onClose(() => {
      this.log('<<< 连接已关闭')
      this.setData({ connected: false, capturing: false })
      this.socket = null
    })

    socket.onError((err) => {
      this.log('!!! 连接错误: ' + JSON.stringify(err))
      this.setData({ connected: false, connecting: false })
      this.socket = null
      wx.showModal({ title: '连接失败', content: '无法连接设备', showCancel: false, complete: () => wx.navigateBack() })
    })

    this.log('>>> 发起TCP连接请求...')
    socket.connect({ address: this.esp32IP, port: this.esp32Port })
  },

  disconnect() {
    if (this.socket) {
      this.log('关闭Socket')
      this.socket.close()
      this.socket = null
    }
    this.setData({ connected: false, capturing: false })
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
    const cmd = 'CAPTURE\n'
    const buffer = new ArrayBuffer(cmd.length)
    const view = new Uint8Array(buffer)
    for (let i = 0; i < cmd.length; i++) {
      view[i] = cmd.charCodeAt(i)
    }
    this.socket.write(buffer)
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
        this.saveImageToLocal(res.tempFilePath)
      },
      fail: (err) => {
        this.log('!!! 导出失败: ' + JSON.stringify(err))
      }
    })
  },

  saveImageToLocal(tempFilePath) {
    this.log('>>> 保存图片: ' + tempFilePath)
    wx.saveFile({
      tempFilePath,
      success: (res) => {
        this.log('<<< 保存成功: ' + res.savedFilePath)
        let images = wx.getStorageSync('savedImages') || []
        images.unshift({
          path: res.savedFilePath,
          time: new Date().toLocaleString(),
          uploaded: false
        })
        wx.setStorageSync('savedImages', images)
        this.log('本地图片总数: ' + images.length)
        this.setData({ savedImages: images, imageCount: images.length })
        wx.showToast({ title: '已保存', icon: 'success' })
      },
      fail: (err) => {
        this.log('!!! 保存失败: ' + JSON.stringify(err))
      }
    })
  },

  goToAlbum() {
    this.log('>>> 跳转相册')
    wx.navigateTo({ url: '/pages/album/album' })
  },

  goToCollect() {
    this.log('>>> 跳转数据采集页面')
    this.disconnect()
    wx.navigateTo({ url: '/pages/collect/collect' })
  }
})
