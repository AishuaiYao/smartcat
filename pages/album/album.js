Page({
  data: {
    images: [],
    selectedCount: 0,
    uploadedCount: 0,
    storageSize: '0KB',
    uploading: false,
    uploadProgress: 0,
    uploadCurrent: 0,
    uploadTotal: 0
  },

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
    const uploadedCount = images.filter(img => img.uploaded).length
    const storageSize = this.calculateStorageSize(images)

    this.setData({
      images: processedImages,
      selectedCount: 0,
      uploadedCount,
      storageSize
    })
  },

  calculateStorageSize(images) {
    let totalSize = 0
    images.forEach(img => {
      try {
        const stats = wx.getFileInfo({ filePath: img.path })
        if (stats && stats.size) {
          totalSize += stats.size
        }
      } catch (e) {}
    })

    if (totalSize < 1024) {
      return totalSize + 'B'
    } else if (totalSize < 1024 * 1024) {
      return (totalSize / 1024).toFixed(1) + 'KB'
    } else {
      return (totalSize / 1024 / 1024).toFixed(1) + 'MB'
    }
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
      content: `确定删除 ${this.data.selectedCount} 张图片？`,
      success: (res) => {
        if (res.confirm) {
          const selectedPaths = this.data.images
            .filter(img => img.selected)
            .map(img => img.path)

          selectedPaths.forEach(path => {
            try {
              wx.removeSavedFile({ filePath: path })
            } catch (e) {}
          })

          let images = this.data.images.filter(img => !img.selected)
          const storageImages = images.map(({ selected, ...rest }) => rest)
          wx.setStorageSync('savedImages', storageImages)

          const uploadedCount = images.filter(img => img.uploaded).length
          const storageSize = this.calculateStorageSize(storageImages)

          this.setData({
            images,
            selectedCount: 0,
            uploadedCount,
            storageSize
          })

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
    this.setData({
      uploading: true,
      uploadProgress: 0,
      uploadCurrent: 0,
      uploadTotal: selectedImages.length
    })

    let successCount = 0
    let failCount = 0
    let completed = 0

    selectedImages.forEach((img) => {
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
          this.setData({
            uploadProgress: Math.round((completed / selectedImages.length) * 100),
            uploadCurrent: completed
          })

          if (completed === selectedImages.length) {
            const storageImages = this.data.images.map(({ selected, ...rest }) => rest)
            wx.setStorageSync('savedImages', storageImages)
            const uploadedCount = this.data.images.filter(img => img.uploaded).length

            this.setData({
              uploading: false,
              uploadProgress: 0,
              selectedCount: 0,
              uploadedCount
            })

            wx.showModal({
              title: '上传完成',
              content: `成功: ${successCount} 张\n失败: ${failCount} 张`,
              showCancel: false
            })
          }
        }
      })
    })
  }
})
