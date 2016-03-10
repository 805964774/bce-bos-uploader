### Baidu Cloud Engine BOS Uploader

bce-bos-uploader 是基于 [bce-sdk-js](https://github.com/baidubce/bce-sdk-js) 开发的一个 ui 组件，易用性更好。

### 支持的浏览器

<http://caniuse.com/#feat=fileapi>

1. 桌面浏览器：IE10+, Firefox/Chrome/Opera 最新版
2. 移动设备上面的未经过完整测试，暂时不确定支持的范围

### 如何使用

```
bower install bce-bos-uploader
```

写一个最简单的页面

```html
<!doctype html>
<html>
  <head>
    <meta charset="utf-8" />
    <title>bce-bos-uploader simple demo</title>
    <script src="./bower_components/jquery/dist/jquery.min.js"></script>
    <script src="./bower_components/bce-bos-uploader/bce-bos-uploader.bundle.js"></script>
  </head>
  <body>
    <input type="file" id="file"
           data-multi_selection="true"
           data-bos_bucket="baidubce"
           data-uptoken_url="http://127.0.0.1:1337/ack" />
    <script>new baidubce.bos.Uploader('#file');</script>
  </body>
</html>
```

> 关于 uptoken_url 应该如何实现，以及如何设置过 Bucket 的 CORS 属性，在以前的文档里面有说明，这里就不赘述了。

当然，也可以去掉 html tag 里面的 data 属性，直接用JS的方式来初始化：

```html
<input type="file" id="file" />
<script>
var uploader = new baidubce.bos.Uploader({
  browse_button: '#file',
  bos_bucket: 'baidubce',
  multi_selection: true,
  uptoken_url: 'http://127.0.0.1:1337/ack'
});
</script>
```


### 支持的配置参数

|*名称*|*是否必填*|*默认值*|*说明*|
|-----|---------|-------|-----|
|bos_bucket|Y|无|需要上传到的Bucket|
|uptoken_url|Y|无|用来进行服务端签名的URL，需要支持JSONP|
|browse_button|Y|无|需要初始化的`<input type="file"/>`|
|bos_endpoint|N|http://bos.bj.baidubce.com|BOS服务器的地址|
|bos_credentials|N|{}|如果没有设置`uptoken_url`的话，必须有这个配置才可以工作|
|multi_selection|N|false|是否可以选择多个文件|
|max_retries|N|0|如果上传文件失败之后，支持的重试次数。默认不重试|
|auto_start|N|false|选择文件之后，是否自动上传|
|max_file_size|N|100M|可以选择的最大文件，超过这个值之后，会被忽略掉|
|bos_multipart_min_size|N|10M|超过这个值之后，采用分片上传的策略。如果想让所有的文件都采用分片上传，把这个值设置为0即可|
|chunk_size|N|4M|分片上传的时候，每个分片的大小（如果没有切换到分片上传的策略，这个值没意义）|

### 支持的事件

在初始化 uploader 的时候，可以通过设置 init 来传递一些 回掉函数，然后 uploader 在合适的时机，会调用这些回掉函数，然后传递必要的参数。例如：

```js
var uploader = new baidubce.bos.Uploader({
  init: {
    PostInit: function () {
      // uploader 初始化完毕之后，调用这个函数
    },
    FileFiltered: function (_, file) {
      // 如果文件因为某些原因被过滤了，调用这个函数
    },
    FilesAdded: function (_, files) {
      // 当文件被加入到队列里面，调用这个函数
    },
    BeforeUpload: function (_, file) {
      // 当某个文件开始上传的时候，调用这个函数
    },
    UploadProgress: function (_, file, progress, event) {
      // 文件的上传进度
    },
    FileUploaded: function (_, file, info) {
      // 文件上传成功之后，调用这个函数
    },
    UploadPartProgress: function (_, file, progress, event) {
      // 分片上传的时候，单个分片的上传进度
    },
    Error: function (_, error, file) {
      // 如果上传的过程中出错了，调用这个函数
    },
    UploadComplete: function () {
      // 队列里面的文件上传结束了，调用这个函数
    }
  }
});
```

> 需要注意的时候，所以回掉函数里面的一个参数，暂时都是 null，因此上面的例子中用 _ 代替，后续可能会升级



