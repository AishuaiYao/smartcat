App({
  onLaunch() {
    // 初始化云开发
    if (wx.cloud) {
      wx.cloud.init({
        // TODO: 替换为你的云开发环境ID
        env: 'your-env-id', // 在云开发控制台获取
        traceUser: true
      })
      console.log('[云开发] 初始化成功')
    } else {
      console.warn('[云开发] 请使用 2.2.3 以上的基础库')
    }
  },

  globalData: {
    esp32IP: '192.168.4.1',
    esp32Port: 5000
  }
})
