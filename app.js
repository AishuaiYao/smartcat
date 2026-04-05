App({
  onLaunch() {
    console.log('[SmartCat] 小程序启动')
    
    // 初始化云开发
    if (wx.cloud) {
      wx.cloud.init({
        env: 'cloud1-2g1p3hkle3a5feb1',
        traceUser: true
      })
      console.log('[SmartCat] 云开发初始化成功')
    } else {
      console.log('[SmartCat] 请使用 2.2.3 或以上的基础库以使用云能力')
    }
  }
})
