Page({
  data: {
    connected: false,
    capturing: false,
    imageData: null,
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

  log(msg) {
    const time = new Date().toLocaleTimeString()
    console.log('[小程序] ' + time + ' ' + msg)
    const msgs = this.data.logMsgs
    msgs.unshift(time + ' | ' + msg)
    if (msgs.length > 50) msgs.pop()
    this.setData({ logMsgs: msgs })
  },

  onLoad() {
    this.log('页面加载')
  },

  onShow() {
    this.log('页面显示')
  },

  onUnload() {
    this.log('页面卸载')
    this.disconnect()
  },

  // TCP连接ESP32
  connectESP32() {
    if (this.data.connected) {
      this.log('主动断开连接')
      this.disconnect()
      return
    }

    this.log('>>> 开始连接 ' + this.esp32IP + ':' + this.esp32Port)

    const socket = wx.createTCPSocket()
    if (!socket) {
      this.log('!!! createTCPSocket 失败')
      return
    }
    this.socket = socket
    this.log('TCPSocket 创建成功')

    socket.onConnect(() => {
      this.log('<<< TCP连接成功')
      this.setData({ connected: true })
      wx.showToast({ title: '连接成功', icon: 'success' })
    })

    socket.onMessage((res) => {
      const bytes = new Uint8Array(res.message)
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
      this.setData({ connected: false, capturing: false })
      this.socket = null
      wx.showToast({ title: '连接失败', icon: 'none' })
    })

    this.log('>>> 发起TCP连接请求...')
    socket.connect({
      address: this.esp32IP,
      port: this.esp32Port
    })
  },

  disconnect() {
    if (this.socket) {
      this.log('关闭Socket')
      this.socket.close()
      this.socket = null
    }
    this.setData({ connected: false, capturing: false })
  },

  // 拍照
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

    const cmd = 'CAPTURE\n'
    this.log('>>> 发送CAPTURE命令, ' + cmd.length + ' 字节')

    const buffer = new ArrayBuffer(cmd.length)
    const view = new Uint8Array(buffer)
    for (let i = 0; i < cmd.length; i++) {
      view[i] = cmd.charCodeAt(i)
    }

    try {
      this.socket.write(buffer)
      this.log('>>> CAPTURE命令已发出')
    } catch (e) {
      this.log('!!! 发送命令异常: ' + JSON.stringify(e))
      this.setData({ capturing: false })
    }
  },

  // 接收TCP数据
  onReceiveData(data) {
    const bytes = new Uint8Array(data)
    let offset = 0

    // 读取帧头（4字节大端长度）
    if (!this.receiveBuffer) {
      this.log('    解析帧头...')
      if (bytes.length < 4) {
        this.log('!!! 数据包不足4字节，当前: ' + bytes.length + ' 字节')
        return
      }

      this.expectedLength = (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]
      offset = 4

      this.log('    帧头: 预期图像=' + this.expectedLength + ' 字节 (预期38400)')

      if (this.expectedLength !== 320 * 120) {
        this.log('!!! 警告: 大小' + this.expectedLength + '与预期38400不一致')
      }

      this.receiveBuffer = new Uint8Array(this.expectedLength)
      this.receiveOffset = 0
      this.chunkCount = 0
    }

    // 写入数据到缓冲区
    const remaining = bytes.length - offset
    const toWrite = Math.min(remaining, this.expectedLength - this.receiveOffset)
    this.receiveBuffer.set(bytes.subarray(offset, offset + toWrite), this.receiveOffset)
    this.receiveOffset += toWrite
    this.chunkCount++

    if (this.chunkCount <= 3 || this.chunkCount % 20 === 0) {
      this.log('    第' + this.chunkCount + '包: +' + toWrite + 'B, 累计' + this.receiveOffset + '/' + this.expectedLength)
    }

    const progress = Math.floor((this.receiveOffset / this.expectedLength) * 100)
    this.setData({ progress })

    // 接收完成
    if (this.receiveOffset >= this.expectedLength) {
      this.log('<<< 图像接收完成! 共' + this.chunkCount + '包, ' + this.receiveOffset + '字节')
      this.processImage(this.receiveBuffer)
      this.receiveBuffer = null
      this.receiveOffset = 0
      this.chunkCount = 0
      this.setData({ capturing: false, progress: 0 })
    }
  },

  // 灰度图转PNG（320x120拼接图：左原图 + 右预测图）
  processImage(grayData) {
    this.log('>>> 处理图像, 长度=' + grayData.length)
    const width = 320   // 拼接图宽度
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

    this.log('>>> Canvas绘制完成, 尺寸=' + width + 'x' + height + ', 导出临时文件')
    wx.canvasToTempFilePath({
      canvas,
      success: (res) => {
        this.log('<<< 导出成功: ' + res.tempFilePath)
        this.setData({ imageData: res.tempFilePath })
        this.saveImageToAlbum(res.tempFilePath)
      },
      fail: (err) => {
        this.log('!!! 导出失败: ' + JSON.stringify(err))
      }
    })
  },

  // 保存到手机相册
  saveImageToAlbum(tempFilePath) {
    this.log('>>> 保存到手机相册: ' + tempFilePath)
    wx.saveImageToPhotosAlbum({
      filePath: tempFilePath,
      success: () => {
        this.log('<<< 已保存到手机相册')
        wx.showToast({ title: '已保存到相册', icon: 'success' })
      },
      fail: (err) => {
        this.log('!!! 保存相册失败: ' + JSON.stringify(err))
      }
    })
  },

  goToAlbum() {
    this.log('>>> 跳转相册')
    wx.navigateTo({ url: '/pages/album/album' })
  }
})
