Page({
  data: {
    imageData: null,
    frameCount: 0,
    streaming: false
  },

  socket: null,
  esp32IP: '192.168.4.1',
  esp32Port: 5000,
  receiveBuffer: null,
  expectedLength: 0,
  receiveOffset: 0,
  headerBuffer: [],

  onLoad() {
    this.connectDevice()
  },

  onUnload() {
    this.disconnect()
  },

  connectDevice() {
    const socket = wx.createTCPSocket()
    if (!socket) {
      wx.showToast({ title: '连接失败', icon: 'none' })
      wx.navigateBack()
      return
    }
    this.socket = socket

    socket.onConnect(() => {
      console.log('[Collect] TCP连接成功，发送HELLO')
      socket.write('HELLO\n')
    })

    socket.onMessage((res) => {
      const bytes = new Uint8Array(res.message)
      console.log('[Collect] onMessage, length=' + bytes.length + ', streaming=' + this.data.streaming)
      
      if (!this.data.streaming) {
        const str = String.fromCharCode(...bytes.subarray(0, Math.min(bytes.length, 50)))
        console.log('[Collect] 检查握手响应: ' + str)
        if (str.includes('LinePatrol') || str.includes('|')) {
          console.log('[Collect] 握手成功，发送STREAM')
          this.sendCommand('STREAM')
          this.setData({ streaming: true })
          return
        }
      }
      
      this.onReceiveData(res.message)
    })

    socket.onClose(() => {
      console.log('[Collect] 连接已关闭')
      this.setData({ streaming: false })
    })

    socket.onError((err) => {
      console.log('[Collect] 连接错误:', err)
      wx.showToast({ title: '连接断开', icon: 'none' })
      this.setData({ streaming: false })
    })

    socket.connect({ address: this.esp32IP, port: this.esp32Port })
  },

  disconnect() {
    if (this.socket) {
      this.sendCommand('STOP')
      this.socket.close()
      this.socket = null
    }
  },

  sendCommand(cmd) {
    const msg = cmd + '\n'
    const buffer = new ArrayBuffer(msg.length)
    const view = new Uint8Array(buffer)
    for (let i = 0; i < msg.length; i++) {
      view[i] = msg.charCodeAt(i)
    }
    this.socket.write(buffer)
    console.log('[Collect] 发送命令: ' + cmd)
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
      }

      const remaining = bytes.length - offset
      const toWrite = Math.min(remaining, this.expectedLength - this.receiveOffset)
      this.receiveBuffer.set(bytes.subarray(offset, offset + toWrite), this.receiveOffset)
      this.receiveOffset += toWrite
      offset += toWrite

      if (this.receiveOffset >= this.expectedLength) {
        this.processImage(this.receiveBuffer)
        this.receiveBuffer = null
        this.receiveOffset = 0
      }
    }
  },

  processImage(grayData) {
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

    const frameCount = this.data.frameCount + 1
    this.setData({ frameCount })

    wx.canvasToTempFilePath({
      canvas,
      success: (res) => {
        this.setData({ imageData: res.tempFilePath })
      }
    })
  },

  onForward() {
    this.sendCommand('MOTOR_FORWARD')
  },

  onBackward() {
    this.sendCommand('MOTOR_BACKWARD')
  },

  onLeft() {
    this.sendCommand('MOTOR_LEFT')
  },

  onRight() {
    this.sendCommand('MOTOR_RIGHT')
  },

  onStop() {
    this.sendCommand('MOTOR_STOP')
  }
})
