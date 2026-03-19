Page({
  data: {
    searching: false,
    robotList: []
  },

  // 搜索机器人
  searchRobots() {
    this.setData({ searching: true })

    // 模拟搜索机器人（实际项目中可替换为蓝牙搜索、网络请求等）
    setTimeout(() => {
      const mockRobots = [
        { id: 1, name: '机器人-A01', status: '在线' },
        { id: 2, name: '机器人-B02', status: '在线' },
        { id: 3, name: '机器人-C03', status: '离线' }
      ]
      
      this.setData({
        searching: false,
        robotList: mockRobots
      })
    }, 1500)
  }
})
