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

  onShow() {
    this.loadImages()
  },

  loadImages() {
    let images = wx.getStorageSync('savedImages') || []
    
    // 调试模式且没有图片时生成测试数据
    if (this.data.debugMode && images.length === 0) {
      this.generateTestImages()
      return
    }

    const processedImages = images.map(img => ({
      ...img,
      selected: false
    }))
    const uploadedCount = images.filter(img => img.uploaded).length

    this.setData({
      images: processedImages,
      selectedCount: 0,
      uploadedCount,
      storageSize: images.length > 0 ? '计算中...' : '0KB'
    })

    if (images.length > 0) {
      this.calculateStorageSize(images)
    }
  },

  data: {
    images: [],
    selectedCount: 0,
    uploadedCount: 0,
    storageSize: '0KB',
    uploading: false,
    uploadProgress: 0,
    uploadCurrent: 0,
    uploadTotal: 0,
    debugMode: false
  },

  SERVER_URL: 'https://your-server.com/upload',

  onLoad(options) {
    const debugMode = options.debug === '1'
    this.setData({ debugMode })
    this.loadImages()
  },

  generateTestImages() {
    this.setData({ storageSize: '生成测试数据...' })

    const testImages = []
    const width = 160
    const height = 120

    for (let i = 0; i < 6; i++) {
      const canvas = wx.createOffscreenCanvas({ type: '2d', width, height })
      const ctx = canvas.getContext('2d')
      const imgData = ctx.createImageData(width, height)

      // 生成不同的灰度图案
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const idx = (y * width + x) * 4
          let gray = 0

          // 不同图案
          if (i === 0) gray = (x + y) % 256 // 渐变
          else if (i === 1) gray = Math.sin(x / 10) * 127 + 128 // 正弦波
          else if (i === 2) gray = ((x % 20) < 10) ? 255 : 0 // 竖条纹
          else if (i === 3) gray = ((y % 20) < 10) ? 255 : 0 // 横条纹
          else if (i === 4) gray = Math.sqrt((x-80)**2 + (y-60)**2) * 2 // 圆形
          else gray = Math.random() * 256 // 随机噪声

          imgData.data[idx] = gray
          imgData.data[idx + 1] = gray
          imgData.data[idx + 2] = gray
          imgData.data[idx + 3] = 255
        }
      }

      ctx.putImageData(imgData, 0, 0)

      wx.canvasToTempFilePath({
        canvas,
        success: (res) => {
          wx.saveFile({
            tempFilePath: res.tempFilePath,
            success: (saveRes) => {
              testImages.push({
                path: saveRes.savedFilePath,
                time: new Date().toLocaleString(),
                uploaded: Math.random() > 0.5
              })

              if (testImages.length === 6) {
                wx.setStorageSync('savedImages', testImages)
                this.loadImages()
              }
            }
          })
        }
      })
    }
  },

  calculateStorageSize(images) {
    let totalSize = 0
    let count = 0

    images.forEach(img => {
      wx.getFileInfo({
        filePath: img.path,
        success: (res) => {
          totalSize += res.size
          count++
          this.updateStorageSize(totalSize, count, images.length)
        },
        fail: () => {
          count++
          this.updateStorageSize(totalSize, count, images.length)
        }
      })
    })

    if (images.length === 0) {
      this.setData({ storageSize: '0KB' })
    }
  },

  updateStorageSize(totalSize, count, total) {
    if (count === total) {
      let sizeText = ''
      if (totalSize < 1024) {
        sizeText = totalSize + 'B'
      } else if (totalSize < 1024 * 1024) {
        sizeText = (totalSize / 1024).toFixed(1) + 'KB'
      } else {
        sizeText = (totalSize / 1024 / 1024).toFixed(2) + 'MB'
      }
      this.setData({ storageSize: sizeText })
    }
  },

  toggleSelect(e) {
    const index = e.currentTarget.dataset.index
    const images = this.data.images
    images[index].selected = !images[index].selected
    const selectedCount = images.filter(img => img.selected).length
    this.setData({ images, selectedCount })
  },

  previewImage(e) {
    const index = e.currentTarget.dataset.index
    const urls = this.data.images.map(img => img.path)
    wx.previewImage({
      current: this.data.images[index].path,
      urls: urls
    })
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

          this.setData({
            images,
            selectedCount: 0,
            uploadedCount,
            storageSize: '计算中...'
          })

          this.calculateStorageSize(storageImages)
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
