const app = getApp()

Page({
  data: {
    firmwareList: [],
    selectedIndex: -1,
    selectedName: '',
    otaSize: '',
    step1Done: false,
    step2Done: false,
    step3Done: false,
    step4Done: false,
    step5Done: false,
    downloading: false,
    flashing: false,
    progress: 0,
    status: '',
    statusType: ''
  },

  onLoad() {
    this.loadFirmwareList()
  },

  onUnload() {
    app.clearOTACallback()
  },

  loadFirmwareList() {
    const list = require('../../firmware-config.js')
    this.setData({ firmwareList: list })
  },

  // Step 1: 选择固件
  onPickerChange(e) {
    const idx = e.detail.value
    const name = this.data.firmwareList[idx].filename
    this.setData({
      selectedIndex: idx,
      selectedName: name,
      step1Done: true
    })
  },

  // Step 2: 确认切换到家庭WiFi
  confirmStep2() {
    this.setData({ step2Done: true, status: '', statusType: '' })
  },

  // Step 3: 拉取固件到本地
  startFetch() {
    const item = this.data.firmwareList[this.data.selectedIndex]
    if (!item) return

    this.setData({ downloading: true, status: '正在下载固件...', statusType: 'info' })

    console.log('[Firmware] 开始下载:', item.filename)
    console.log('[Firmware] URL:', item.url)

    // 调试：查看 getTempFileURL 的返回值
    const fileID = 'cloud://' + app.globalData.cloudEnvPrefix + '/firmware/' + item.filename
    wx.cloud.getTempFileURL({
      fileList: [fileID],
      success: res => {
        console.log('[Firmware] getTempFileURL 返回:', JSON.stringify(res.fileList[0]))
      },
      fail: err => {
        console.log('[Firmware] getTempFileURL 失败:', JSON.stringify(err))
      }
    })

    wx.downloadFile({
      url: item.url,
      success: dRes => {
        if (dRes.statusCode !== 200) {
          console.error('[Firmware] HTTP 状态码异常:', dRes.statusCode)
          this.setData({ downloading: false, status: '下载失败: HTTP ' + dRes.statusCode, statusType: 'error' })
          return
        }
        console.log('[Firmware] 下载完成, tempFilePath:', dRes.tempFilePath)
        const fs = wx.getFileSystemManager()
        fs.readFile({
          filePath: dRes.tempFilePath,
          success: readRes => {
            const buffer = readRes.data
            const size = buffer.byteLength || buffer.length
            console.log('[Firmware] 固件大小:', size, 'bytes')
            this._otaData = new Uint8Array(buffer instanceof ArrayBuffer ? buffer : buffer.buffer)
            this._otaFilename = item.filename
            const sizeStr = size > 1048576 ? (size / 1048576).toFixed(2) + ' MB' : (size / 1024).toFixed(0) + ' KB'
            this.setData({
              downloading: false,
              step3Done: true,
              otaSize: sizeStr,
              status: '拉取成功！请切换回设备 WiFi',
              statusType: 'success'
            })
          },
          fail: err => {
            console.error('[Firmware] 读取文件失败:', err)
            this.setData({ downloading: false, status: '读取固件失败', statusType: 'error' })
          }
        })
      },
      fail: err => {
        console.error('[Firmware] 下载失败:', err)
        this.setData({ downloading: false, status: '下载失败: ' + JSON.stringify(err), statusType: 'error' })
      }
    })
  },

  // Step 4: 确认切换回设备WiFi
  confirmStep4() {
    this.setData({ step4Done: true, status: '已就绪，请确保设备页面已连接 ESP32', statusType: 'info' })
  },

  // Step 5: 烧录固件
  startFlash() {
    if (!this._otaData || !this._otaFilename) {
      this.setData({ status: '请先拉取固件', statusType: 'error' })
      return
    }
    if (this.data.flashing) return

    this.setData({ flashing: true, progress: 0, status: '正在启动 OTA...', statusType: 'info' })

    app.setOTACallback(this.onOTAMessage.bind(this))
    this._otaOffset = 0

    app.sendCommand('OTA:START:' + this._otaFilename + ':' + this._otaData.length)
  },

  onOTAMessage(res) {
    const bytes = new Uint8Array(res.message)
    const text = String.fromCharCode(...bytes).trim()
    console.log('[Firmware] OTA 响应:', text)

    if (text === 'OTA_READY') {
      this.setData({ status: '正在烧录固件...', statusType: 'info' })
      this.sendNextChunk()
    } else if (text.startsWith('OTA_PROGRESS:')) {
      const pct = parseInt(text.split(':')[1])
      this.setData({ progress: pct })
    } else if (text === 'OTA_OK') {
      this.setData({
        flashing: false,
        progress: 100,
        step5Done: true,
        status: '烧录成功！请重启机器人，并重新打开小程序',
        statusType: 'success'
      })
      app.clearOTACallback()
    } else if (text.startsWith('OTA_FAIL:')) {
      const reason = text.substring(9)
      this.setData({ flashing: false, status: '烧录失败: ' + reason, statusType: 'error' })
      app.clearOTACallback()
    }
  },

  sendNextChunk() {
    const chunkSize = 2048
    if (this._otaOffset >= this._otaData.length) return

    const end = Math.min(this._otaOffset + chunkSize, this._otaData.length)
    const chunk = this._otaData.slice(this._otaOffset, end)
    const buf = new ArrayBuffer(chunk.length)
    new Uint8Array(buf).set(chunk)
    app.sendBinary(buf)
    this._otaOffset = end

    if (this._otaOffset < this._otaData.length) {
      setTimeout(() => { this.sendNextChunk() }, 30)
    }
  },

  goBack() {
    wx.navigateBack()
  }
})
