App({
  onLaunch() {
    console.log('[SmartCat] 小程序启动')
  },
  globalData: {
    esp32IP: '192.168.4.1',
    esp32Port: 8080
  }
})
