Page({
  data: {
    images: [],
    selectedCount: 0,
    uploading: false,
    uploadProgress: 0
  },

  // 上传服务器地址（后续替换为你的服务器）
  SERVER_URL: 'https://your-server.com/upload',

  onLoad() {
    this.loadImages()
  },

  onShow() {
    this.loadImages()
  },

  loadImages() {
    const images = wx.getStorageSync('savedImages') || []
    const processedImages = images.map(img => ({
      ...img,
      selected: false
    }))
    this.setData({ images: processedImages, selectedCount: 0 })
  },

  toggleSelect(e) {
    const index = e.currentTarget.dataset.index
    const images = this.data.images
    images[index].selected = !images[index].selected
    const selectedCount = images.filter(img => img.selected).length
    this.setData({ images, selectedCount })
  },

  selectAll() {
    const images = this.data.images.map(img => ({ ...img, selected: true }))
    this.setData({ images, selectedCount: images.length })
  },

  deselectAll() {
    const images = this.data.images.map(img => ({ ...img, selected: false }))
    this.setData({ images, selectedCount: 0 })
  },

  deleteSelected() {
    if (this.data.selectedCount === 0) {
      wx.showToast({ title: '请先选择图片', icon: 'none' })
      return
    }

    wx.showModal({
      title: '确认删除',
      content: '确定删除 ' + this.data.selectedCount + ' 张图片？',
      success: (res) => {
        if (res.confirm) {
          let images = this.data.images.filter(img => !img.selected)
          const storageImages = images.map(({ selected, ...rest }) => rest)
          wx.setStorageSync('savedImages', storageImages)
          this.setData({ images, selectedCount: 0 })
          wx.showToast({ title: '删除成功', icon: 'success' })
        }
      }
    })
  },

  uploadSelected() {
    if (this.data.selectedCount === 0) {
      wx.showToast({ title: '请先选择图片', icon: 'none' })
      return
    }

    const selectedImages = this.data.images.filter(img => img.selected)
    this.setData({ uploading: true, uploadProgress: 0 })

    let successCount = 0
    let failCount = 0
    let completed = 0

    selectedImages.forEach((img, i) => {
      wx.uploadFile({
        url: this.SERVER_URL,
        filePath: img.path,
        name: 'file',
        success: () => {
          successCount++
          const images = this.data.images
          const idx = images.findIndex(item => item.path === img.path)
          if (idx !== -1) {
            images[idx].uploaded = true
            images[idx].selected = false
          }
          this.setData({ images })
        },
        fail: (err) => {
          failCount++
          console.log('上传失败:', err)
        },
        complete: () => {
          completed++
          const progress = Math.round((completed / selectedImages.length) * 100)
          this.setData({ uploadProgress: progress })

          if (completed === selectedImages.length) {
            const storageImages = this.data.images.map(({ selected, ...rest }) => rest)
            wx.setStorageSync('savedImages', storageImages)
            this.setData({ uploading: false, uploadProgress: 0, selectedCount: 0 })
            wx.showModal({
              title: '上传完成',
              content: '成功: ' + successCount + ' 张\n失败: ' + failCount + ' 张',
              showCancel: false
            })
          }
        }
      })
    })
  },

  previewImage(e) {
    const src = e.currentTarget.dataset.src
    const urls = this.data.images.map(img => img.path)
    wx.previewImage({ current: src, urls })
  }
})
