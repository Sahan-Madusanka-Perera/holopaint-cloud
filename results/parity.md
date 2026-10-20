| model | size (MB) | outline IoU mean | IoU worst | prob. MAE | s/photo 481x321 | s/photo 1280x720 |
|---|---:|---:|---:|---:|---:|---:|
| holopaint_unet.pth | 118.5 | 1.0000 | 1.0000 | 0.00000 | 0.54 | 3.64 |
| unet_fp32.onnx | 118.4 | 1.0000 | 1.0000 | 0.00000 | 1.72 | 8.58 |
| unet_int8_dynamic.onnx | 37.6 | 0.9928 | 0.9796 | 0.00199 | 0.68 | 3.40 |
| unet_int8_static.onnx | 29.7 | 0.9907 | 0.9821 | 0.00326 | 0.59 | 2.94 |
