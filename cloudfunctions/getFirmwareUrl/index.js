const cloud = require('wx-server-sdk')
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV })

// 云存储文件路径前缀
const CLOUD_PREFIX = 'cloud://cloud1-2g1p3hkle3a5feb1.636c-cloud1-2g1p3hkle3a5feb1-1412914450/firmware/'

exports.main = async (event, context) => {
  const { filename } = event
  console.log('[getFirmwareUrl] 请求文件名:', filename)

  if (!filename) {
    return { success: false, errMsg: '缺少 filename 参数' }
  }

  const fileID = CLOUD_PREFIX + filename
  console.log('[getFirmwareUrl] fileID:', fileID)

  const result = await cloud.getTempFileURL({
    fileList: [fileID]
  })

  const file = result.fileList[0]
  console.log('[getFirmwareUrl] 结果:', JSON.stringify(file))

  if (file.tempFileURL) {
    return {
      success: true,
      url: file.tempFileURL
    }
  } else {
    return {
      success: false,
      errMsg: file.errMsg || '获取下载链接失败'
    }
  }
}

