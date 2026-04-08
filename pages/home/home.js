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
    console.log('[Home] 点击搜索按钮')
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
    console.log('[Home] ========== 开始搜索设备 ==========')
    console.log('[Home] 目标地址: ' + this.data.esp32IP + ':' + this.data.esp32Port)
    
    const socket = wx.createTCPSocket()
    if (!socket) {
      console.log('[Home] !!! 创建TCPSocket失败')
      this.setData({ radarStatus: '创建连接失败' })
      return
    }
    console.log('[Home] TCPSocket创建成功')
    this.socket = socket

    socket.onConnect(() => {
      console.log('[Home] TCP连接成功，发送HELLO握手')
      this.setData({ radarStatus: '握手ing...' })
      socket.write('HELLO\n')
    })

    socket.onMessage(res => {
      const info = String.fromCharCode(...new Uint8Array(res.message)).trim()
      console.log('[Home] <<< 收到设备响应: ' + info)
      const parts = info.split('|')
      const name = parts[0] || '未知设备'
      const icon = parts[1] || '📦'
      const mac = parts[2] || ''
      console.log('[Home] 设备信息: name=' + name + ', icon=' + icon + ', mac=' + mac)
      this.setData({ radarStatus: '设备已找到!', showConfirm: true, deviceName: name, deviceIcon: icon, deviceMac: mac })
    })

    socket.onClose(() => {
      console.log('[Home] TCP连接关闭')
      if (this.data.showRadar && !this.data.showConfirm) {
        console.log('[Home] 连接超时')
        this.setData({ radarStatus: '连接超时' })
        setTimeout(() => this.closeRadar(), 1500)
      }
    })

    socket.onError((err) => {
      console.log('[Home] !!! TCP连接错误:', err)
      if (this.data.showRadar && !this.data.showConfirm) {
        console.log('[Home] 连接失败')
        this.setData({ radarStatus: '连接失败' })
        setTimeout(() => this.closeRadar(), 1500)
      }
    })

    console.log('[Home] >>> 发起TCP连接...')
    socket.connect({ address: this.data.esp32IP, port: this.data.esp32Port })
    console.log('[Home] ====================================')
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
    console.log('[Home] 点击设备卡片: ' + device.name)
    wx.showLoading({ title: '连接中...', mask: true })

    const socket = wx.createTCPSocket()
    this.testSocket = socket

    socket.onConnect(() => {
      console.log('[Home] 设备连接成功，发送HELLO')
      socket.write('HELLO\n')
    })

    socket.onMessage(res => {
      const info = String.fromCharCode(...new Uint8Array(res.message)).trim()
      console.log('[Home] 设备响应: ' + info)
      wx.hideLoading()
      socket.close()
      this.testSocket = null
      wx.navigateTo({ url: `/pages/device/device?name=${device.name}&icon=${device.icon}&mac=${device.mac}` })
    })

    socket.onError((err) => {
      console.log('[Home] !!! 设备连接错误:', err)
      wx.hideLoading()
      wx.showToast({ title: '无法连接设备', icon: 'none' })
      this.testSocket = null
    })

    socket.onClose(() => {
      console.log('[Home] 设备连接关闭')
      wx.hideLoading()
    })

    console.log('[Home] >>> 连接设备: ' + this.data.esp32IP + ':' + this.data.esp32Port)
    socket.connect({ address: this.data.esp32IP, port: this.data.esp32Port })
  },

  onSettingsTap() {
    this.setData({ showDelete: !this.data.showDelete })
  },

  onDebugTap() {
    wx.navigateTo({ url: '/pages/device/device?name=模拟设备&icon=📦&mac=debug&debug=1' })
  },

  onDeleteDevice(e) {
    const id = e.currentTarget.dataset.id
    const devices = this.data.devices.filter(d => d.id !== id)
    this.setData({ devices, showDelete: false })
    this.saveDevices()
  },

  catchTap() {},

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
