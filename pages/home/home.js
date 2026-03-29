Page({
  data: {
    devices: [],
    showRadar: false,
    showConfirm: false,
    radarStatus: '搜索设备中...',
    esp32IP: '192.168.4.1',
    esp32Port: 5000
  },

  socket: null,

  onLoad() {
    this.loadDevices()
  },

  onShow() {
    this.loadDevices()
  },

  loadDevices() {
    const devices = wx.getStorageSync('devices') || []
    this.setData({ devices })
  },

  saveDevices() {
    wx.setStorageSync('devices', this.data.devices)
  },

  onFabTap() {
    this.setData({ showRadar: true, showConfirm: false, radarStatus: '搜索设备中...' })
    this.searchDevice()
  },

  onRadarClose() {
    if (this.data.showConfirm) return
    this.closeRadar()
  },

  closeRadar() {
    this.setData({ showRadar: false, showConfirm: false })
    if (this.socket) {
      this.socket.close()
      this.socket = null
    }
  },

  searchDevice() {
    const socket = wx.createTCPSocket()
    if (!socket) {
      this.setData({ radarStatus: '创建连接失败' })
      return
    }
    this.socket = socket

    socket.onConnect(() => {
      this.setData({ radarStatus: '设备已找到!', showConfirm: true })
    })

    socket.onClose(() => {
      if (this.data.showRadar && !this.data.showConfirm) {
        this.setData({ radarStatus: '连接超时' })
        setTimeout(() => this.closeRadar(), 1500)
      }
    })

    socket.onError(() => {
      if (this.data.showRadar && !this.data.showConfirm) {
        this.setData({ radarStatus: '连接失败' })
        setTimeout(() => this.closeRadar(), 1500)
      }
    })

    socket.connect({ address: this.data.esp32IP, port: this.data.esp32Port })
  },

  onConfirm() {
    const newDevice = {
      id: Date.now(),
      name: 'ESP32-CAM',
      icon: '📷',
      status: '在线'
    }
    const devices = [...this.data.devices, newDevice]
    this.setData({ devices })
    this.saveDevices()
    this.closeRadar()
  },

  onCardTap(e) {
    const id = e.currentTarget.dataset.id
    wx.navigateTo({ url: '/pages/index/index' })
  },

  onSettingsTap() {
    console.log('点击设置')
  },

  onTabTap(e) {
    const tab = e.currentTarget.dataset.tab
    const pages = {
      home: '/pages/home/home',
      smart: '/pages/smart/smart',
      assistant: '/pages/assistant/assistant',
      my: '/pages/my/my'
    }
    if (pages[tab]) {
      wx.redirectTo({ url: pages[tab] })
    }
  }
})
