App({
  globalData: {
    tcpSocket: null,
    udpSocket: null,
    connected: false,
    esp32IP: '192.168.4.1',
    esp32Port: 5000,
    udpLocalPort: 5001,
    messageCallbacks: [],
    closeCallbacks: [],
    errorCallbacks: []
  },

  onLaunch() {
    console.log('[SmartCat] 小程序启动')
    
    if (wx.cloud) {
      wx.cloud.init({
        env: 'cloud1-2g1p3hkle3a5feb1',
        traceUser: true
      })
      console.log('[SmartCat] 云开发初始化成功')
    } else {
      console.log('[SmartCat] 请使用 2.2.3 或以上的基础库以使用云能力')
    }
  },

  connectTCP(callback) {
    if (this.globalData.tcpSocket && this.globalData.connected) {
      console.log('[App] TCP已连接，复用现有连接')
      callback && callback(true)
      return true
    }

    console.log('[App] 创建新TCP连接')
    const socket = wx.createTCPSocket()
    if (!socket) {
      console.log('[App] 创建TCPSocket失败')
      callback && callback(false)
      return false
    }

    this.globalData.tcpSocket = socket

    socket.onConnect(() => {
      console.log('[App] TCP连接成功')
      socket.write('HELLO\n')
    })

    socket.onMessage((res) => {
      this.globalData.messageCallbacks.forEach(cb => cb(res))
    })

    socket.onClose(() => {
      console.log('[App] TCP连接关闭')
      this.globalData.connected = false
      this.globalData.tcpSocket = null
      this.globalData.closeCallbacks.forEach(cb => cb())
    })

    socket.onError((err) => {
      console.log('[App] TCP错误:', err)
      this.globalData.connected = false
      this.globalData.tcpSocket = null
      this.globalData.errorCallbacks.forEach(cb => cb(err))
    })

    socket.connect({ 
      address: this.globalData.esp32IP, 
      port: this.globalData.esp32Port 
    })
    return true
  },

  setConnected(connected) {
    this.globalData.connected = connected
  },

  sendCommand(cmd) {
    if (!this.globalData.tcpSocket) {
      console.log('[App] TCP未连接，无法发送命令')
      return false
    }
    const msg = cmd + '\n'
    const buffer = new ArrayBuffer(msg.length)
    const view = new Uint8Array(buffer)
    for (let i = 0; i < msg.length; i++) {
      view[i] = msg.charCodeAt(i)
    }
    this.globalData.tcpSocket.write(buffer)
    console.log('[App] 发送命令: ' + cmd)
    return true
  },

  disconnectTCP() {
    if (this.globalData.udpSocket) {
      this.globalData.udpSocket.close()
      this.globalData.udpSocket = null
    }
    if (this.globalData.tcpSocket) {
      console.log('[App] 断开TCP连接')
      this.sendCommand('STOP')
      this.globalData.tcpSocket.close()
      this.globalData.tcpSocket = null
    }
    this.globalData.connected = false
    this.globalData.messageCallbacks = []
    this.globalData.closeCallbacks = []
    this.globalData.errorCallbacks = []
  },

  addMessageCallback(callback) {
    this.globalData.messageCallbacks.push(callback)
  },

  removeMessageCallback(callback) {
    const index = this.globalData.messageCallbacks.indexOf(callback)
    if (index > -1) {
      this.globalData.messageCallbacks.splice(index, 1)
    }
  },

  addCloseCallback(callback) {
    this.globalData.closeCallbacks.push(callback)
  },

  removeCloseCallback(callback) {
    const index = this.globalData.closeCallbacks.indexOf(callback)
    if (index > -1) {
      this.globalData.closeCallbacks.splice(index, 1)
    }
  },

  addErrorCallback(callback) {
    this.globalData.errorCallbacks.push(callback)
  },

  removeErrorCallback(callback) {
    const index = this.globalData.errorCallbacks.indexOf(callback)
    if (index > -1) {
      this.globalData.errorCallbacks.splice(index, 1)
    }
  },

  setUDPSocket(socket) {
    this.globalData.udpSocket = socket
  }
})
