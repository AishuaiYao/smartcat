// 固件文件列表，只需写云存储中 firmware/ 下的文件名即可
// 云函数 getFirmwareUrl 会自动拼接前缀并生成临时下载链接
module.exports = [
  "model_in_flash_rodata.bin",
  "model_in_flash_rodata_ota.bin",
  "model_in_flash_rodata_ota1.bin",
  "model_in_flash_rodata_ota2.bin"
]
