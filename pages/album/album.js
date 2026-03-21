Page({
  data: {
    images: [],
    selectedCount: 0,
    uploading: false,
    uploadProgress: 0
  },

  onLoad() {
    this.loadImages()
  },

  onShow() {
    this.loadImages()
  },

  // 加载本地图片
  loadImages() {
    const images = wx.getStorageSync('savedImages') || []
    const processedImages = images.map(img => ({
      ...img,
      selected: false
    }))
    this.setData({ images: processedImages, selectedCount: 0 })
  },

  // 选择/取消选择
  toggleSelect(e) {
    const index = e.currentTarget.dataset.index
    const images = this.data.images
    images[index].selected = !images[index].selected
    
    const selectedCount = images.filter(img => img.selected).length
    this.setData({ images, selectedCount })
  },

  // 全选
  selectAll() {
    const images = this.data.images.map(img => ({ ...img, selected: true }))
    this.setData({ images, selectedCount: images.length })
  },

  // 取消全选
  deselectAll() {
    const images = this.data.images.map(img => ({ ...img, selected: false }))
    this.setData({ images, selectedCount: 0 })
  },

  // 删除选中
  deleteSelected() {
    if (this.data.selectedCount === 0) {
      wx.showToast({ title: '请先选择图片', icon: 'none' })
      return
    }

    wx.showModal({
      title: '确认删除',
      content: `确定删除 ${this.data.selectedCount} 张图片？`,
      success: (res) => {
        if (res.confirm) {
          let images = this.data.images.filter(img => !img.selected)
          // 移除selected属性后保存
          const storageImages = images.map(({ selected, ...rest }) => rest)
          wx.setStorageSync('savedImages', storageImages)
          this.setData({ images, selectedCount: 0 })
          wx.showToast({ title: '删除成功', icon: 'success' })
        }
      }
    })
  },

  // 上传到云开发
  async uploadSelected() {
    if (this.data.selectedCount === 0) {
      wx.showToast({ title: '请先选择图片', icon: 'none' })
      return
    }

    const selectedImages = this.data.images.filter(img => img.selected)
    
    this.setData({ uploading: true, uploadProgress: 0 })
    
    let successCount = 0
    let failCount = 0

    for (let i = 0; i < selectedImages.length; i++) {
      const img = selectedImages[i]
      
      const cloudPath = `photos/${Date.now()}_${Math.random().toString(36).substr(2, 9)}.png`
      
      wx.cloud.uploadFile({
        cloudPath: cloudPath,
        filePath: img.path,
        success: () => {
          successCount++
          // 更新状态
          const images = this.data.images
          const idx = images.findIndex(item => item.path === img.path)
          if (idx !== -1) {
            images[idx].uploaded = true
            images[idx].selected = false
          }
          this.setData({ images })
        },
        fail: () => {
          failCount++
        },
        complete: () => {
          const progress = Math.round(((i + 1) / selectedImages.length) * 100)
          this.setData({ uploadProgress: progress })
        }
      })
      
      // 等待上传完成
      await new Promise(resolve => setTimeout(resolve, 500))
    }

    // 保存状态
    const storageImages = this.data.images.map(({ selected, ...rest }) => rest)
    wx.setStorageSync('savedImages', storageImages)

    this.setData({ 
      uploading: false, 
      uploadProgress: 0,
      selectedCount: 0
    })

    wx.showModal({
      title: '上传完成',
      content: `成功: ${successCount} 张\n失败: ${failCount} 张`,
      showCancel: false
    })
  },

  // 预览图片
  previewImage(e) {
    const src = e.currentTarget.dataset.src
    const urls = this.data.images.map(img => img.path)
    wx.previewImage({
      current: src,
      urls: urls
    })
  }
})
