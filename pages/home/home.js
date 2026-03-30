Page({
  data: {
    devices: [],
    showRadar: false,
    showConfirm: false,
    showDelete: false,
    radarStatus: '搜索设备中...',
    esp32IP: '192.168.4.1',
    esp32Port: 5000,
    deviceName: '',
    deviceIcon: '',
    deviceMac: ''
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
    this.setData({ showRadar: false, showConfirm: false, deviceName: '', deviceIcon: '', deviceMac: '' })
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
      this.setData({ radarStatus: '握手ing...' })
      socket.write('HELLO\n')
    })

    socket.onMessage(res => {
      const info = String.fromCharCode(...new Uint8Array(res.message)).trim()
      const parts = info.split('|')
      const name = parts[0] || '未知设备'
      const icon = parts[1] || '📦'
      const mac = parts[2] || ''
      this.setData({ radarStatus: '设备已找到!', showConfirm: true, deviceName: name, deviceIcon: icon, deviceMac: mac })
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
    const exists = this.data.devices.find(d => d.mac === this.data.deviceMac)
    if (exists) {
      this.setData({ radarStatus: '设备已存在!' })
      setTimeout(() => this.closeRadar(), 1500)
      return
    }
    const newDevice = {
      id: Date.now(),
      name: this.data.deviceName,
      icon: this.data.deviceIcon,
      mac: this.data.deviceMac,
      status: '在线'
    }
    const devices = [...this.data.devices, newDevice]
    this.setData({ devices })
    this.saveDevices()
    this.closeRadar()
  },

  onCardTap(e) {
    const device = e.currentTarget.dataset.device
    wx.showLoading({ title: '连接中...', mask: true })

    const socket = wx.createTCPSocket()
    this.testSocket = socket

    socket.onConnect(() => {
      socket.write('HELLO\n')
    })

    socket.onMessage(res => {
      wx.hideLoading()
      socket.close()
      this.testSocket = null
      wx.navigateTo({ url: `/pages/index/index?name=${device.name}&icon=${device.icon}&mac=${device.mac}` })
    })

    socket.onError(() => {
      wx.hideLoading()
      wx.showToast({ title: '无法连接设备', icon: 'none' })
      this.testSocket = null
    })

    socket.onClose(() => {
      wx.hideLoading()
    })

    socket.connect({ address: this.data.esp32IP, port: this.data.esp32Port })
  },

  onSettingsTap() {
    this.setData({ showDelete: !this.data.showDelete })
  },

  onDeleteDevice(e) {
    const id = e.currentTarget.dataset.id
    const devices = this.data.devices.filter(d => d.id !== id)
    this.setData({ devices, showDelete: false })
    this.saveDevices()
  },

  catchTap() {
    // 阻止事件冒泡
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
