Page({
  data: {
    connected: false,
    capturing: false,
    imageData: null,
    savedImages: [],
    imageCount: 0
  },

  tcpSocket: null,

  log(msg) {
    console.log(`[小程序] ${new Date().toLocaleTimeString()} ${msg}`)
  },

  onLoad() {
    this.log('拍照页面加载')
    this.loadSavedImages()
  },

  onShow() {
    this.loadSavedImages()
  },

  onUnload() {
    if (this.tcpSocket) this.tcpSocket.close()
  },

  // 加载已保存的图片列表
  loadSavedImages() {
    const images = wx.getStorageSync('savedImages') || []
    this.setData({ savedImages: images, imageCount: images.length })
    this.log(`已加载 ${images.length} 张本地图片`)
  },

  // 连接ESP32
  connectESP32() {
    const ip = '192.168.4.1'
    this.log(`开始连接ESP32: ${ip}:5000`)
    
    if (this.tcpSocket) {
      this.tcpSocket.close()
    }
    
    this.tcpSocket = wx.createTCPSocket()
    
    this.tcpSocket.onConnect(() => {
      this.log('TCP连接成功!')
      this.setData({ connected: true })
      wx.showToast({ title: '连接成功', icon: 'success' })
    })

    this.tcpSocket.onMessage(this.onTcpMessage.bind(this))
    
    this.tcpSocket.onError((err) => {
      this.log(`TCP错误: ${JSON.stringify(err)}`)
      this.setData({ connected: false })
      wx.showToast({ title: '连接失败', icon: 'none' })
    })

    this.tcpSocket.onClose(() => {
      this.log('TCP连接关闭')
      this.setData({ connected: false })
    })

    this.tcpSocket.connect({ address: ip, port: 5000 })
  },

  // 断开连接
  disconnect() {
    if (this.tcpSocket) {
      this.tcpSocket.close()
      this.tcpSocket = null
    }
    this.setData({ connected: false })
    this.log('已断开连接')
  },

  // TCP消息处理
  receiveBuffer: null,
  expectedLength: 0,

  onTcpMessage(res) {
    const data = new Uint8Array(res.message)
    this.log(`收到数据: ${data.length} 字节`)
    
    if (!this.receiveBuffer) {
      // 读取帧头（4字节大端长度）
      this.expectedLength = (data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3]
      this.log(`图像大小: ${this.expectedLength} 字节`)
      this.receiveBuffer = data.slice(4)
    } else {
      const temp = new Uint8Array(this.receiveBuffer.length + data.length)
      temp.set(this.receiveBuffer)
      temp.set(data, this.receiveBuffer.length)
      this.receiveBuffer = temp
    }

    // 数据接收完成
    if (this.receiveBuffer.length >= this.expectedLength) {
      this.log('图像接收完成，开始处理...')
      this.processImage(this.receiveBuffer.slice(0, this.expectedLength))
      this.receiveBuffer = null
      this.expectedLength = 0
      this.setData({ capturing: false })
    }
  },

  // 处理图像数据（灰度图转Canvas）
  processImage(grayData) {
    const width = 160
    const height = 120
    const rgbaData = new Uint8ClampedArray(width * height * 4)

    for (let i = 0; i < grayData.length; i++) {
      const gray = grayData[i]
      rgbaData[i * 4] = gray
      rgbaData[i * 4 + 1] = gray
      rgbaData[i * 4 + 2] = gray
      rgbaData[i * 4 + 3] = 255
    }

    // 使用Canvas绘制
    const canvas = wx.createOffscreenCanvas({ type: '2d', width, height })
    const ctx = canvas.getContext('2d')
    const imgData = ctx.createImageData(width, height)
    imgData.data.set(rgbaData)
    ctx.putImageData(imgData, 0, 0)

    // 转为临时文件
    wx.canvasToTempFilePath({
      canvas,
      success: (res) => {
        this.log(`图像处理成功: ${res.tempFilePath}`)
        this.setData({ imageData: res.tempFilePath })
        
        // 保存到本地
        this.saveImageToLocal(res.tempFilePath)
      },
      fail: (err) => {
        this.log(`图像处理失败: ${JSON.stringify(err)}`)
        wx.showToast({ title: '处理失败', icon: 'none' })
      }
    })
  },

  // 保存图片到本地存储
  saveImageToLocal(tempFilePath) {
    const fileName = `img_${Date.now()}.png`
    
    wx.saveFile({
      tempFilePath: tempFilePath,
      success: (res) => {
        const savedPath = res.savedFilePath
        this.log(`图片已保存: ${savedPath}`)
        
        // 更新保存列表
        let images = wx.getStorageSync('savedImages') || []
        images.unshift({
          path: savedPath,
          time: new Date().toLocaleString(),
          uploaded: false
        })
        wx.setStorageSync('savedImages', images)
        
        this.setData({ 
          savedImages: images, 
          imageCount: images.length 
        })
        
        wx.showToast({ title: '已保存到本地', icon: 'success' })
      },
      fail: (err) => {
        this.log(`保存失败: ${JSON.stringify(err)}`)
        wx.showToast({ title: '保存失败', icon: 'none' })
      }
    })
  },

  // 采集图像
  captureImage() {
    if (!this.data.connected) {
      wx.showToast({ title: '请先连接ESP32', icon: 'none' })
      return
    }
    
    this.log('发送采集命令: CAPTURE')
    this.setData({ capturing: true })
    this.tcpSocket.send({ message: 'CAPTURE' })
  },

  // 跳转到相册页面
  goToAlbum() {
    wx.navigateTo({ url: '/pages/album/album' })
  }
})
