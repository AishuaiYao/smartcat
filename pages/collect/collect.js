const app = getApp()

Page({
  data: {
    imageData: null
  },

  socket: null,
  esp32IP: '192.168.4.1',
  esp32Port: 5000,
  receiveBuffer: null,
  expectedLength: 0,
  receiveOffset: 0,
  chunkCount: 0,

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
      return
    }
    this.socket = socket

    socket.onConnect(() => {
      socket.write('HELLO\n')
    })

    socket.onMessage((res) => {
      const bytes = new Uint8Array(res.message)
      if (!this.data.imageData && bytes.length < 100) {
        return
      }
      this.onReceiveData(res.message)
    })

    socket.onError(() => {
      wx.showToast({ title: '连接断开', icon: 'none' })
    })

    socket.connect({ address: this.esp32IP, port: this.esp32Port })
  },

  disconnect() {
    if (this.socket) {
      const cmd = 'MODE_INFERENCE\n'
      const buffer = new ArrayBuffer(cmd.length)
      const view = new Uint8Array(buffer)
      for (let i = 0; i < cmd.length; i++) {
        view[i] = cmd.charCodeAt(i)
      }
      this.socket.write(buffer)
      this.socket.close()
      this.socket = null
    }
  },

  onReceiveData(data) {
    const bytes = new Uint8Array(data)
    let offset = 0

    if (!this.receiveBuffer) {
      if (bytes.length < 4) return
      this.expectedLength = (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3]
      offset = 4
      this.receiveBuffer = new Uint8Array(this.expectedLength)
      this.receiveOffset = 0
      this.chunkCount = 0
    }

    const remaining = bytes.length - offset
    const toWrite = Math.min(remaining, this.expectedLength - this.receiveOffset)
    this.receiveBuffer.set(bytes.subarray(offset, offset + toWrite), this.receiveOffset)
    this.receiveOffset += toWrite
    this.chunkCount++

    if (this.receiveOffset >= this.expectedLength) {
      this.processImage(this.receiveBuffer)
      this.receiveBuffer = null
      this.receiveOffset = 0
      this.chunkCount = 0
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

    wx.canvasToTempFilePath({
      canvas,
      success: (res) => {
        this.setData({ imageData: res.tempFilePath })
      }
    })
  },

  sendCommand(cmd) {
    if (this.socket) {
      const msg = cmd + '\n'
      const buffer = new ArrayBuffer(msg.length)
      const view = new Uint8Array(buffer)
      for (let i = 0; i < msg.length; i++) {
        view[i] = msg.charCodeAt(i)
      }
      this.socket.write(buffer)
    }
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
