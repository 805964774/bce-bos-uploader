/**
 * Copyright (c) 2014 Baidu.com, Inc. All Rights Reserved
 *
 * Licensed under the Apache License, Version 2.0 (the "License"); you may not use this file except in compliance with
 * the License. You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under the License is distributed on
 * an "AS IS" BASIS, WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied. See the License for the
 * specific language governing permissions and limitations under the License.
 *
 * @file uploader.js
 * @author leeight
 */

var urlModule = require('url');
var qsModule = require('querystring');
var sdk = require('bce-sdk-js');
var u = require('underscore');
var async = require('async');
var debug = require('debug')('bce-bos-uploader');

var utils = require('./utils');

var kDefaultOptions = {
    runtimes: 'html5',

    // bos服务器的地址，默认（http://bos.bj.baidubce.com）
    bos_endpoint: 'http://bos.bj.baidubce.com',

    // 默认的 ak 和 sk 配置
    bos_credentials: null,

    // 如果切换到 appendable 模式，最大只支持 5G 的文件
    // 不再支持 Multipart 的方式上传文件
    bos_appendable: false,

    // 为了处理 Flash 不能发送 HEAD, DELETE 之类的请求，以及无法
    // 获取 response headers 的问题，需要搞一个 relay 服务器，把数据
    // 格式转化一下
    bos_relay_server: 'https://relay.efe.tech',

    // 是否支持多选，默认（false）
    multi_selection: false,

    // 失败之后重试的次数（单个文件或者分片），默认（0），不重试
    max_retries: 0,

    // 是否自动上传，默认（false）
    auto_start: false,

    // 最大可以选择的文件大小，默认（100M）
    max_file_size: '100mb',

    // 超过这个文件大小之后，开始使用分片上传，默认（10M）
    bos_multipart_min_size: '10mb',

    // 分片上传的时候，并行上传的个数，默认（1）
    bos_multipart_parallel: 1,

    // 计算签名的时候，有些 header 需要剔除，减少传输的体积
    auth_stripped_headers: ['User-Agent', 'Connection'],

    // 分片上传的时候，每个分片的大小，默认（4M）
    chunk_size: '4mb',

    // 分块上传时,是否允许断点续传，默认（true）
    bos_multipart_auto_continue: true,

    // 分开上传的时候，localStorage里面key的生成方式，默认是 `default`
    // 如果需要自定义，可以通过 XXX
    bos_multipart_local_key_generator: 'default',

    // 是否允许选择目录
    dir_selection: false,

    // 是否需要每次都去服务器计算签名
    get_new_uptoken: true,

    bos_token_mode: null,

    // 低版本浏览器上传文件的时候，需要设置 policy，默认情况下
    // policy的内容只需要包含 expiration 和 conditions 即可
    // policy: {
    //   expiration: 'xx',
    //   conditions: [
    //     {bucket: 'the-bucket-name'}
    //   ]
    // }
    bos_policy: null,

    // 低版本浏览器上传文件的时候，需要设置 policy_signature
    // 如果没有设置 bos_policy_signature 的话，会通过 uptoken_url 来请求
    // 默认只会请求一次，如果失效了，需要手动来重置 policy_signature
    bos_policy_signature: null,

    // JSONP 默认的超时时间(5000ms)
    uptoken_jsonp_timeout: 5000
};

var kPostInit = 'PostInit';
var kKey = 'Key';
var kListParts = 'ListParts';

// var kFilesRemoved   = 'FilesRemoved';
var kFileFiltered = 'FileFiltered';
var kFilesAdded = 'FilesAdded';
var kFilesFilter = 'FilesFilter';

var kBeforeUpload = 'BeforeUpload';
// var kUploadFile     = 'UploadFile';       // ??
var kUploadProgress = 'UploadProgress';
var kFileUploaded = 'FileUploaded';
var kUploadPartProgress = 'UploadPartProgress';
var kChunkUploaded = 'ChunkUploaded';
var kUploadResume = 'UploadResume'; // 断点续传
var kUploadResumeError = 'UploadResumeError'; // 尝试断点续传失败

var kError = 'Error';
var kUploadComplete = 'UploadComplete';

// 预先定义几种签名的策略
var TokenMode = {
    DEFAULT: 'default',
    STS: 'sts',
    POLICY: 'policy'
};

/**
 * BCE BOS Uploader
 *
 * @constructor
 * @param {Object|string} options 配置参数
 */
function Uploader(options) {
    if (u.isString(options)) {
        // 支持简便的写法，可以从 DOM 里面分析相关的配置.
        options = u.extend({
            browse_button: options,
            auto_start: true
        }, $(options).data());
    }

    var runtimeOptions = {
        bos_policy: utils.getDefaultPolicy(options.bos_bucket)
    };
    this.options = u.extend({}, kDefaultOptions, runtimeOptions, options);
    this.options.max_file_size = utils.parseSize(this.options.max_file_size);
    this.options.bos_multipart_min_size
        = utils.parseSize(this.options.bos_multipart_min_size);
    this.options.chunk_size = this._resetChunkSize(
        utils.parseSize(this.options.chunk_size));

    if (!this.options.bos_token_mode) {
        this.options.bos_token_mode = this._guessTokenMode();
    }

    var credentials = this.options.bos_credentials;
    if (!credentials && this.options.bos_ak && this.options.bos_sk) {
        this.options.bos_credentials = {
            ak: this.options.bos_ak,
            sk: this.options.bos_sk
        };
    }

    /**
     * @type {sdk.BosClient}
     */
    this.client = new sdk.BosClient({
        endpoint: utils.normalizeEndpoint(this.options.bos_endpoint),
        credentials: this.options.bos_credentials,
        sessionToken: this.options.uptoken
    });

    /**
     * 需要等待上传的文件列表，每次上传的时候，从这里面删除
     * 成功或者失败都不会再放回去了
     * @param {Array.<File>}
     */
    this._files = [];

    /**
     * FIXME(leeight) 当前正在上传的文件.
     * @type {File}
     */
    this._currentFile = null;

    /**
     * 是否被中断了，比如 this.stop
     * @type {boolean}
     */
    this._abort = false;

    /**
     * 是否处于上传的过程中，也就是正在处理 this._files 队列的内容.
     * @type {boolean}
     */
    this._working = false;

    /**
     * 是否支持xhr2
     * @type {boolean}
     */
    this._xhr2Supported = utils.isXhr2Supported();

    this._init();
}

Uploader.prototype._resetChunkSize = function (chunkSize) {
    // TODO
    return chunkSize;
};

Uploader.prototype._getCustomizedSignature = function (uptokenUrl) {
    var options = this.options;
    var timeout = options.uptoken_jsonp_timeout;

    return function (_, httpMethod, path, params, headers) {
        if (/\bed=([\w\.]+)\b/.test(location.search)) {
            headers.Host = RegExp.$1;
        }

        if (u.isArray(options.auth_stripped_headers)) {
            headers = u.omit(headers, options.auth_stripped_headers);
        }

        var deferred = sdk.Q.defer();
        $.ajax({
            url: uptokenUrl,
            jsonp: 'callback',
            dataType: 'jsonp',
            timeout: timeout,
            data: {
                httpMethod: httpMethod,
                path: path,
                // delay: ~~(Math.random() * 10),
                params: JSON.stringify(params || {}),
                headers: JSON.stringify(headers || {})
            },
            error: function () {
                deferred.reject(new Error('Get authorization timeout (' + timeout + 'ms).'));
            },
            success: function (payload) {
                if (payload.statusCode === 200 && payload.signature) {
                    deferred.resolve(payload.signature, payload.xbceDate);
                }
                else {
                    deferred.reject(new Error('createSignature failed, statusCode = ' + payload.statusCode));
                }
            }
        });
        return deferred.promise;
    };
};

/**
 * 调用 this.options.init 里面配置的方法
 *
 * @param {string} methodName 方法名称
 * @param {Array.<*>} args 调用时候的参数.
 * @param {boolean=} throwErrors 如果发生异常的时候，是否需要抛出来
 * @return {*} 事件的返回值.
 */
Uploader.prototype._invoke = function (methodName, args, throwErrors) {
    var init = this.options.init || this.options.Init;
    if (!init) {
        return;
    }

    var method = init[methodName];
    if (typeof method !== 'function') {
        return;
    }

    try {
        var up = null;
        args = args == null ? [up] : [up].concat(args);
        return method.apply(null, args);
    }
    catch (ex) {
        debug('%s(%j) -> %s', methodName, args, ex);
        if (throwErrors === true) {
            return sdk.Q.reject(ex);
        }
    }
};

/**
 * 初始化控件.
 */
Uploader.prototype._init = function () {
    var options = this.options;
    var accept = options.accept;

    var self = this;
    if (!this._xhr2Supported
        && !u.isUndefined(mOxie)
        && u.isFunction(mOxie.FileInput)) {
        // https://github.com/moxiecode/moxie/wiki/FileInput
        // mOxie.FileInput 只支持
        // [+]: browse_button, accept multiple, directory, file
        // [x]: container, required_caps
        var fileInput = new mOxie.FileInput({
            runtime_order: 'flash,html4',
            browse_button: $(options.browse_button).get(0),
            swf_url: options.flash_swf_url,
            accept: utils.expandAcceptToArray(accept),
            multiple: options.multi_selection,
            directory: options.dir_selection,
            file: 'file'      // PostObject接口要求固定是 'file'
        });

        fileInput.onchange = u.bind(this._onFilesAdded, this);
        fileInput.init();
    }

    if (options.bos_token_mode === TokenMode.POLICY) {
        this._initPolicySignature().then(function (payload) {
            if (payload) {
                self.options.bos_policy_base64 = payload.policy;
                self.options.bos_policy_signature = payload.signature;
                self.options.bos_ak = payload.accessKey;
            }
            self._invoke(kPostInit);
        })
        .catch(function (error) {
            debug(error);
            self._invoke(kError, [error]);
        });
    }
    else if (options.bos_token_mode === TokenMode.STS) {
        // 切换到了 STS 的模式
        this._initStsToken()
            .then(function (payload) {
                if (payload) {
                    // 重新初始化一个 sdk.BosClient
                    self.client = new sdk.BosClient({
                        endpoint: utils.normalizeEndpoint(options.bos_endpoint),
                        credentials: {
                            ak: payload.AccessKeyId,
                            sk: payload.SecretAccessKey
                        },
                        sessionToken: payload.SessionToken
                    });
                    self.client.createSignature = function (_, httpMethod, path, params, headers) {
                        var credentials = _ || this.config.credentials;
                        return sdk.Q.fcall(function () {
                            var auth = new sdk.Auth(credentials.ak, credentials.sk);
                            return auth.generateAuthorization(httpMethod, path, params, headers);
                        });
                    };
                }
                self._initEvents();
                self._invoke(kPostInit);
            })
            .catch(function (error) {
                debug(error);
                self._invoke(kError, [error]);
            });
    }
    else {
        if (!options.bos_credentials && options.uptoken_url
            && options.get_new_uptoken === true) {
            // 服务端动态签名的方式.
            this.client.createSignature = this._getCustomizedSignature(options.uptoken_url);
        }
        else if (options.bos_credentials) {
            this.client.createSignature = function (_, httpMethod, path, params, headers) {
                var credentials = _ || this.config.credentials;
                return sdk.Q.fcall(function () {
                    var auth = new sdk.Auth(credentials.ak, credentials.sk);
                    return auth.generateAuthorization(httpMethod, path, params, headers);
                });
            };
        }
        this._initEvents();
        this._invoke(kPostInit);
    }
};

Uploader.prototype._initEvents = function () {
    var options = this.options;
    var btn = $(options.browse_button);
    if (btn.attr('multiple') == null) {
        // 如果用户没有显示的设置过 multiple，使用 multi_selection 的设置
        // 否则保留 <input multiple /> 的内容
        btn.attr('multiple', !!options.multi_selection);
    }
    btn.on('change', u.bind(this._onFilesAdded, this));

    var accept = options.accept;
    if (accept != null) {
        btn.attr('accept', utils.expandAccept(accept));
    }

    if (options.dir_selection) {
        btn.attr('directory', true);
        btn.attr('mozdirectory', true);
        btn.attr('webkitdirectory', true);
    }

    this.client.on('progress', u.bind(this._onUploadProgress, this));
    // XXX 必须绑定 error 的处理函数，否则会 throw new Error
    this.client.on('error', u.bind(this._onError, this));
};

Uploader.prototype._initStsToken = function () {
    var uptoken_url = this.options.uptoken_url;
    var bucket = this.options.bos_bucket;
    var timeout = this.options.uptoken_jsonp_timeout;

    var deferred = sdk.Q.defer();
    $.ajax({
        url: uptoken_url,
        jsonp: 'callback',
        dataType: 'jsonp',
        timeout: timeout,
        data: {
            sts: JSON.stringify(utils.getDefaultACL(bucket))
        },
        success: function (payload) {
            // payload.AccessKeyId
            // payload.SecretAccessKey
            // payload.SessionToken
            // payload.Expiration
            deferred.resolve(payload);
        },
        error: function () {
            deferred.reject(new Error('Get policy signature timeout (' + timeout + 'ms).'));
        }
    });
    return deferred.promise;
};

Uploader.prototype._initPolicySignature = function () {
    var options = this.options;
    var bos_policy = options.bos_policy;
    var bos_policy_signature = options.bos_policy_signature;
    var uptoken_url = options.uptoken_url;
    var timeout = options.uptoken_jsonp_timeout;

    if (!bos_policy) {
        // 如果没有设置 bos_policy，莫非因为 bucket 是 public-read-write?
        // 因为默认情况下 bos_policy 是有内容设置的，所以如果出现不存在的情况
        // 肯定是使用者显式的设置成 null 了
        return sdk.Q.resolve();
    }

    if (!bos_policy_signature) {
        // 如果设置了 bos_policy 但是没有设置 bos_policy_signature
        // 那么就动态的从后台请求一次
        if (!uptoken_url) {
            return sdk.Q.reject(new Error('In order to get policy signature, `uptoken_url` must be setted.'));
        }

        var deferred = sdk.Q.defer();
        $.ajax({
            url: uptoken_url,
            jsonp: 'callback',
            dataType: 'jsonp',
            timeout: timeout,
            data: {
                policy: JSON.stringify(bos_policy)
            },
            success: function (payload) {
                // payload.policy (base64)
                // payload.signature
                // payload.accessKey
                deferred.resolve(payload);
            },
            error: function () {
                deferred.reject(new Error('Get policy signature timeout (' + timeout + 'ms).'));
            }
        });
        return deferred.promise;
    }

    // 不需要用户自己设置，主动计算一下就好了.
    if (options.bos_policy_base64 == null) {
        options.bos_policy_base64 = new Buffer(JSON.stringify(
            bos_policy)).toString('base64');
    }

    return sdk.Q.resolve();
};

Uploader.prototype._filterFiles = function (candidates) {
    var self = this;

    // 如果 maxFileSize === 0 就说明不限制大小
    var maxFileSize = this.options.max_file_size;

    var files = u.filter(candidates, function (file) {
        if (maxFileSize > 0 && file.size > maxFileSize) {
            self._invoke(kFileFiltered, [file]);
            return false;
        }

        // TODO
        // 检查后缀之类的

        return true;
    });

    return this._invoke(kFilesFilter, [files]) || files;
};

Uploader.prototype._onFilesAdded = function (e) {
    var files = e.target.files;
    if (!files) {
        // IE7, IE8 低版本浏览器的处理
        var name = e.target.value.split(/[\/\\]/).pop();
        files = [
            {name: name, size: 0}
        ];
    }
    files = this._filterFiles(files);
    if (u.isArray(files) && files.length) {
        this._invoke(kFilesAdded, [files]);
        this._files.push.apply(this._files, files);
    }

    if (this.options.auto_start) {
        this.start();
    }
};

Uploader.prototype._onError = function (e) {
    debug(e);
    // this._invoke(kError, [e, this._currentFile]);
};

Uploader.prototype._onUploadProgress = function (e) {
    var progress = e.lengthComputable
        ? e.loaded / e.total
        : 0;
    // FIXME(leeight) 这种判断方法不太合适.
    if (this.client._httpAgent
        && this.client._httpAgent._req) {
        var req = this.client._httpAgent._req;
        var uri = req.uri;

        if (/[\?&]append=?&?/.test(uri)) {
            // 这里就不要触发 kUploadProgress 了
            return;
        }

        var headers = req._headers;
        var partNumber = headers['x-bce-meta-part-number'];
        if (partNumber != null) {
            this._invoke(kUploadPartProgress, [this._currentFile, progress, e]);
            return;
        }
    }

    this._invoke(kUploadProgress, [this._currentFile, progress, e]);
};

Uploader.prototype.start = function () {
    if (this._working) {
        return;
    }

    if (this._files.length) {
        this._working = true;
        this._uploadNext();
    }
};

Uploader.prototype.stop = function () {
    this._abort = true;
    this._working = false;
};

/**
 * 如果已经上传完毕了，返回 undefined
 *
 * @return {File|undefined}
 */
Uploader.prototype._getNext = function () {
    return this._files.shift();
};

Uploader.prototype._guessTokenMode = function () {
    var options = this.options;
    if (options.bos_token_mode) {
        return options.bos_token_mode;
    }

    if (!this._xhr2Supported) {
        return TokenMode.POLICY;
    }

    if (options.uptoken_url && options.get_new_uptoken === false) {
        return TokenMode.STS;
    }

    return TokenMode.DEFAULT;
};

Uploader.prototype._guessContentType = function (file, opt_ignoreCharset) {
    var contentType = file.type;
    if (true || !contentType) {
        var object = file.name;
        var ext = object.split(/\./g).pop();
        contentType = sdk.MimeType.guess(ext);
    }

    // Firefox在POST的时候，Content-Type 一定会有Charset的，因此
    // 这里不管3721，都加上.
    if (!opt_ignoreCharset && !/charset=/.test(contentType)) {
        contentType += '; charset=UTF-8';
    }

    return contentType;
};

Uploader.prototype._uploadNextViaMultipart = function (file, bucket, object) {
    var contentType = this._guessContentType(file);
    var options = {
        'Content-Type': contentType
    };

    var self = this;
    var uploadId = null;
    var multipartParallel = this.options.bos_multipart_parallel;
    var chunkSize = this.options.chunk_size;

    return this._initiateMultipartUpload(file, chunkSize, bucket, object, options)
        .then(function (response) {
            uploadId = response.body.uploadId;
            var parts = response.body.parts || [];
            // 准备 uploadParts
            var deferred = sdk.Q.defer();
            var tasks = utils.getTasks(file, uploadId, chunkSize, bucket, object);
            utils.filterTasks(tasks, parts);

            var loaded = parts.length;
            // 这个用来记录整体 Parts 的上传进度，不是单个 Part 的上传进度
            // 单个 Part 的上传进度可以监听 kUploadPartProgress 来得到
            var state = {
                lengthComputable: true,
                loaded: loaded,
                total: tasks.length
            };
            if (loaded) {
                self._invoke(kUploadProgress, [file, loaded / tasks.length, null]);
            }

            async.mapLimit(tasks, multipartParallel, self._uploadPart(state),
                function (err, results) {
                    if (err) {
                        deferred.reject(err);
                    }
                    else {
                        deferred.resolve(results);
                    }
                });

            return deferred.promise;
        })
        .then(function (responses) {
            var partList = [];
            u.each(responses, function (response, index) {
                partList.push({
                    partNumber: index + 1,
                    eTag: response.http_headers.etag
                });
            });
            // 全部上传结束后删除localStorage
            self._generateLocalKey({
                blob: file,
                chunkSize: chunkSize,
                bucket: bucket,
                object: object
            }).then(function (key) {
                utils.removeUploadId(key);
            });
            return self.client.completeMultipartUpload(bucket, object, uploadId, partList);
        })
        .then(function (response) {
            response.body.bucket = bucket;
            response.body.object = object;
            self._invoke(kFileUploaded, [file, response]);
        })
        .catch(function (error) {
            self._invoke(kError, [error, file]);
        })
        .fin(function () {
            // 上传结束（成功/失败），开始下一个
            return self._uploadNext();
        });
};

Uploader.prototype._generateLocalKey = function (options) {
    var generator = this.options.bos_multipart_local_key_generator;
    return utils.generateLocalKey(options, generator);
};

Uploader.prototype._initiateMultipartUpload = function (file, chunkSize, bucket, object, options) {
    var self = this;
    var uploadId;
    var localSaveKey;

    function initNewMultipartUpload() {
        return self.client.initiateMultipartUpload(bucket, object, options)
            .then(function (response) {
                if (localSaveKey) {
                    utils.setUploadId(localSaveKey, response.body.uploadId);
                }

                response.body.parts = [];
                return response;
            });
    }

    var keyOptions = {
        blob: file,
        chunkSize: chunkSize,
        bucket: bucket,
        object: object
    };
    var promise = this.options.bos_multipart_auto_continue
        ? this._generateLocalKey(keyOptions)
        : sdk.Q.resolve(null);

    return promise.then(function (key) {
            localSaveKey = key;
            if (!localSaveKey) {
                return initNewMultipartUpload();
            }

            uploadId = utils.getUploadId(localSaveKey);
            if (!uploadId) {
                return initNewMultipartUpload();
            }

            return self._listParts(bucket, object, uploadId);
        })
        .then(function (response) {
            if (uploadId && localSaveKey) {
                var parts = response.body.parts;
                // listParts 的返回结果
                self._invoke(kUploadResume, [file, parts, null]);
                response.body.uploadId = uploadId;
            }
            return response;
        })
        .catch(function (error) {
            if (uploadId && localSaveKey) {
                // 如果获取已上传分片失败，则重新上传。
                self._invoke(kUploadResumeError, [file, error, null]);
                utils.removeUploadId(localSaveKey);
                return initNewMultipartUpload();
            }
            throw error;
        });
};

Uploader.prototype._listParts = function (bucket, object, uploadId) {
    var self = this;
    var localParts = this._invoke(kListParts, [this._currentFile, uploadId]);

    return sdk.Q.resolve(localParts)
        .then(function (parts) {
            if (u.isArray(parts)) {
                return {
                    http_headers: {},
                    body: {
                        parts: parts
                    }
                };
            }

            // 如果返回的不是数组，就调用 listParts 接口从服务器获取数据
            return self.client.listParts(bucket, object, uploadId);
        });
};

Uploader.prototype._uploadPart = function (state) {
    var self = this;

    function uploadPartInner(item, opt_maxRetries) {
        if (item.etag) {
            // 跳过已上传的part
            return sdk.Q.resolve({
                http_headers: {
                    etag: item.etag
                },
                body: {}
            });
        }
        var maxRetries = opt_maxRetries == null
            ? self.options.max_retries
            : opt_maxRetries;

        var blob = item.file.slice(item.start, item.stop + 1);
        var options = {
            'x-bce-meta-part-number': item.partNumber
        };
        return self.client.uploadPartFromBlob(item.bucket, item.object, item.uploadId,
            item.partNumber, item.partSize, blob, options)
            .then(function (response) {
                ++state.loaded;
                var progress = state.loaded / state.total;
                self._invoke(kUploadProgress, [self._currentFile, progress, null]);

                var result = {
                    uploadId: item.uploadId,
                    partNumber: item.partNumber,
                    partSize: item.partSize,
                    bucket: item.bucket,
                    object: item.object,
                    offset: item.start,
                    total: blob.size,
                    response: response
                };
                self._invoke(kChunkUploaded, [self._currentFile, result]);

                return response;
            })
            .catch(function (error) {
                if (maxRetries > 0) {
                    // 还有重试的机会
                    return uploadPartInner(item, maxRetries - 1);
                }
                // 没有机会重试了 :-(
                throw error;
            });

    }

    return function (item, callback) {
        // file: file,
        // uploadId: uploadId,
        // bucket: bucket,
        // object: object,
        // partNumber: partNumber,
        // partSize: partSize,
        // start: offset,
        // stop: offset + partSize - 1

        var resolve = function (response) {
            callback(null, response);
        };
        var reject = function (error) {
            callback(error);
        };

        uploadPartInner(item).then(resolve, reject);
    };
};

Uploader.prototype._uploadNextViaPostObject = function (file, bucket, object) {
    var self = this;
    var options = this.options;
    var url = options.bos_endpoint.replace(/^(https?:\/\/)/, '$1' + bucket + '.');
    var fields = {
        'Content-Type': self._guessContentType(file, true),
        'key': object,
        'policy': options.bos_policy_base64,
        'signature': options.bos_policy_signature,
        'accessKey': options.bos_ak,
        'success-action-status': '201'
    };

    return this._sendPostRequest(url, fields, file)
        .then(function (response) {
            response.body.bucket = bucket;
            response.body.object = object;
            self._invoke(kFileUploaded, [file, response]);
        })
        .catch(function (error) {
            debug(error);
            self._invoke(kError, [error, file]);
        })
        .fin(function () {
            return self._uploadNext();
        });
};

Uploader.prototype._sendPostRequest = function (url, fields, file) {
    var self = this;
    var deferred = sdk.Q.defer();

    if (u.isUndefined(mOxie)
        || !u.isFunction(mOxie.FormData)
        || !u.isFunction(mOxie.XMLHttpRequest)) {
        deferred.reject(new Error('mOxie is undefined.'));
        return deferred.promise;
    }

    var formData = new mOxie.FormData();
    u.each(fields, function (value, name) {
        if (value == null) {
            return;
        }
        formData.append(name, value);
    });
    formData.append('file', file);

    var xhr = new mOxie.XMLHttpRequest();
    // xhr.responseType = 'text';
    xhr.onreadystatechange = function (e) {
        if (xhr.readyState === 4) {
            if (xhr.status === 200) {
                deferred.resolve({
                    http_headers: {},
                    body: {}
                });
            }
            else {
                deferred.reject(new Error('Invalid response statusCode ' + xhr.status));
            }
        }
    };
    if (xhr.upload) {
        xhr.upload.onprogress = function (e) {
            var progress = e.loaded / e.total;
            self._invoke(kUploadProgress, [file, progress, null]);
        };
    }
    xhr.bind('error', function (e) {
        deferred.reject(e);
    });
    xhr.bind('RuntimeError', function (e) {
        deferred.reject(e);
    });
    xhr.open('POST', url, true);
    xhr.send(formData, {
        runtime_order: 'flash',
        swf_url: self.options.flash_swf_url
    });

    return deferred.promise;
};


Uploader.prototype._uploadNext = function (opt_maxRetries) {
    var file = this._getNext();
    if (file == null || this._abort) {
        // 自动结束了 或者 人为结束了
        this._working = false;
        this._invoke(kUploadComplete);
        return;
    }

    var returnValue = this._invoke(kBeforeUpload, [file]);
    if (returnValue === false) {
        return this._uploadNext();
    }

    // 设置一下当前正在上传的文件，progress 事件需要用到
    this._currentFile = file;

    var self = this;
    var options = this.options;
    var bucket = options.bos_bucket;
    var object = file.name;
    var throwErrors = true;

    return sdk.Q.resolve(this._invoke(kKey, [file], throwErrors))
        .then(function (result) {
            if (u.isString(result)) {
                object = result;
            }
            else if (u.isObject(result)) {
                bucket = result.bucket || bucket;
                object = result.key || object;
            }

            if (options.bos_appendable === true) {
                return self._uploadNextViaAppendObject(file, bucket, object);
            }

            // 判断一下应该采用何种方式来上传
            if (!self._xhr2Supported) {
                return self._uploadNextViaPostObject(file, bucket, object);
            }

            var multipartMinSize = options.bos_multipart_min_size;
            if (file.size > multipartMinSize) {
                return self._uploadNextViaMultipart(file, bucket, object);
            }

            return self._uploadNextViaPutObject(file, bucket, object);
        });
};

Uploader.prototype._getObjectMetadata = function (bucket, object) {
    // 如果浏览器不支持 xhr2，那么就切换到 mOxie.XMLHttpRequest
    // 但是因为 mOxie.XMLHttpRequest 无法发送 HEAD 请求，无法获取 Response Headers，
    // 因此 getObjectMetadata实际上无法正常工作，因此我们需要：
    // 1. 让 BOS 新增 REST API，在 GET 的请求的同时，把 x-bce-* 放到 Response Body 返回
    // 2. 临时方案：新增一个 Relay 服务，实现方案 1
    //    GET /bj.bcebos.com/v1/bucket/object?httpMethod=HEAD
    //    Host: relay.efe.tech
    //    Authorization: xxx
    if (!this._xhr2Supported && !u.isUndefined(mOxie) && u.isFunction(mOxie.XMLHttpRequest)
        && !this.client.hasOwnProperty('sendHTTPRequest')) {
        this.client.sendHTTPRequest = u.bind(this._customHTTPRequestHandler, this);
    }

    return this.client.getObjectMetadata(bucket, object)
        .catch(function (error) {
            if (error.status_code === 404) {
                // 文件不存在，可以上传一个新的了
                return {
                    http_headers: {
                        'content-length': 0,
                        'x-bce-next-append-offset': 0,
                        'x-bce-object-type': 'Appendable'
                    },
                    body: {}
                };
            }

            throw error;
        });
};

Uploader.prototype._customHTTPRequestHandler = function (httpMethod, resource, args, config) {
    var self = this;
    var options = self.options;

    var endpointHost = urlModule.parse(config.endpoint).host;
    var endpointProtocol = urlModule.parse(config.endpoint).protocol;

    // x-bce-date 和 Date 二选一，是必须的
    // 但是 Flash 无法设置 Date，因此必须设置 x-bce-date
    args.headers['x-bce-date'] = new Date().toISOString().replace(/\.\d+Z$/, 'Z');
    args.headers.host = endpointHost;

    var xhrUri;
    var xhrMethod = httpMethod;
    var xhrBody = args.body;
    if (httpMethod === 'HEAD') {
        // 因为 Flash 的 URLRequest 只能发送 GET 和 POST 请求
        // getObjectMeta需要用HEAD请求，但是 Flash 无法发起这种请求
        // 所需需要用 relay 中转一下
        // XXX 因为 bucket 不可能是 private，否则 crossdomain.xml 是无法读取的
        // 所以这个接口请求的时候，可以不需要 authorization 字段
        var relayServer = utils.normalizeEndpoint(options.bos_relay_server);
        xhrUri = relayServer + '/' + endpointHost + resource;

        args.params.httpMethod = httpMethod;

        xhrMethod = 'POST';

        // 必须要有 BODY 才能是 POST，否则你设置了也没有
        // 而且必须是 POST 才可以设置自定义的header，GET不行
        xhrBody = 'hello=world';
    }
    else {
        // http://bos.bj.baidubce.com/v1/${bucket}/${object}
        // http://${bucket}.bos.bj.baidubce.com/v1/${object}
        var chunks = ('\ufefe' + resource).split('/');
        var bucket = chunks[2];
        chunks.splice(0, 1);    // Remove \ufefe
        chunks.splice(1, 1);    // Remove bucket

        resource = '/' + chunks.join('/');

        endpointHost = (bucket + '.' + endpointHost);
        args.headers.host = endpointHost;

        xhrUri = endpointProtocol + '//' + endpointHost + resource;
    }

    var deferred = sdk.Q.defer();

    var xhr = new mOxie.XMLHttpRequest();

    xhr.onload = function () {
        if (xhr.status === 200) {
            if (httpMethod === 'HEAD') {
                deferred.resolve(JSON.parse(xhr.response));
            }
            else {
                // 应该没有这个分支
                deferred.resolve({http_headers: {}, body: {}});
            }
        }
        else {
            deferred.reject({
                status_code: xhr.status,
                message: ''
            });
        }
    };

    xhr.onerror = function (error) {
        deferred.reject(error);
    };

    var promise = self.client.createSignature(null, httpMethod,
        resource, args.params, args.headers);
    promise.then(function (authorization, xbceDate) {
        if (authorization) {
            args.headers.authorization = authorization;
        }

        if (xbceDate) {
            args.headers['x-bce-date'] = xbceDate;
        }

        var qs = qsModule.stringify(args.params);
        if (qs) {
            xhrUri += '?' + qs;
        }

        xhr.open(xhrMethod, xhrUri, true);

        for (var key in args.headers) {
            if (!args.headers.hasOwnProperty(key)
                || key === 'host') {
                continue;
            }
            var value = args.headers[key];
            xhr.setRequestHeader(key, value);
        }

        /*
        alert([
            'xhrMethod=' + xhrMethod,
            'xhrUri=' + xhrUri,
            'headers=' + JSON.stringify(args.headers),
            'params=' + JSON.stringify(args.params)
        ].join('\n'));
        */

        xhr.send(xhrBody, {
            runtime_order: 'flash',
            swf_url: self.options.flash_swf_url
        });
    })
    .catch(function (error) {
        deferred.reject(error);
    });

    return deferred.promise;
};

Uploader.prototype._uploadNextViaAppendObject = function (file, bucket, object) {
    // 调用 getObjectMeta 接口获取 x-bce-next-append-offset 和 x-bce-object-type
    // 如果 x-bce-object-type 不是 "Appendable"，那么就不支持断点续传了
    var self = this;
    var options = this.options;
    var contentType = this._guessContentType(file);

    this._getObjectMetadata(bucket, object)
        .then(function (response) {
            var httpHeaders = response.http_headers;
            var appendable = utils.isAppendable(httpHeaders);
            if (!appendable) {
                // Normal Object 不能切换为 Appendable Object
                self._invoke(kUploadProgress, [file, 1, null]);
                return self._uploadNext();
            }

            var contentLength = +(httpHeaders['content-length']);
            if (contentLength >= file.size) {
                // 服务端的文件不小于本地，就没必要上传了
                self._invoke(kUploadProgress, [file, 1, null]);
                return self._uploadNext();
            }

            // offset 和 content-length 应该是一样大小的吧？
            var offset = +httpHeaders['x-bce-next-append-offset'];

            // 上传进度
            var progress = file.size <= 0 ? 0 : offset / file.size;
            self._invoke(kUploadProgress, [file, progress, null]);

            // 排除了 offset 之后，按照 chunk_size 切分文件
            // XXX 一般来说，如果启用了 (bos_appendable)，就可以考虑把 chunk_size 设置为一个比较小的值
            var chunkSize = options.chunk_size;
            var tasks = utils.getAppendableTasks(file.size, offset, chunkSize);

            var deferred = sdk.Q.defer();
            async.mapLimit(tasks, 1,
                function (item, callback) {
                    var offset = item.start;
                    var offsetArgument = offset > 0 ? offset : null;
                    var blob = file.slice(offset, item.stop + 1);
                    var resolve = function (response) {
                        var progress = (item.stop + 1) / file.size;
                        self._invoke(kUploadProgress, [file, progress, null]);
                        callback(null, response);
                    };
                    var reject = function (error) {
                        callback(error);
                    };
                    var options = {
                        'Content-Type': contentType,
                        'Content-Length': item.partSize
                    };
                    self.client.appendObjectFromBlob(bucket, object,
                        blob, offsetArgument, options).then(resolve, reject);
                },
                function (err, results) {
                    if (err) {
                        deferred.reject(err);
                    }
                    else {
                        deferred.resolve(results);
                    }
                });
            return deferred.promise;
        })
        .then(function () {
            var response = {
                http_headers: {},
                body: {
                    bucket: bucket,
                    object: object
                }
            };
            self._invoke(kFileUploaded, [file, response]);
            return self._uploadNext();
        })
        .catch(function (error) {
            self._invoke(kError, [error, file]);
            return self._uploadNext();
        });
};

Uploader.prototype._uploadNextViaPutObject = function (file, bucket, object, opt_maxRetries) {
    var contentType = this._guessContentType(file);
    var options = {
        'Content-Type': contentType
    };

    var self = this;
    var maxRetries = opt_maxRetries == null
        ? this.options.max_retries
        : opt_maxRetries;

    return this.client.putObjectFromBlob(bucket, object, file, options)
        .then(function (response) {
            if (file.size <= 0) {
                // 如果文件大小为0，不会触发 xhr 的 progress 事件，因此
                // 在上传成功之后，手工触发一次
                self._invoke(kUploadProgress, [file, 1]);
            }
            response.body.bucket = bucket;
            response.body.object = object;
            self._invoke(kFileUploaded, [file, response]);
            // 上传成功，开始下一个
            return self._uploadNext();
        })
        .catch(function (error) {
            self._invoke(kError, [error, file]);
            if (error.status_code && error.code && error.request_id) {
                // 应该是正常的错误（比如签名异常），这种情况就不要重试了
                return self._uploadNext();
            }
            else if (maxRetries > 0) {
                // 还有几乎重试
                return self._uploadNextViaPutObject(file, bucket, object, maxRetries - 1);
            }
            // 重试结束了，不管了，继续下一个文件的上传
            return self._uploadNext();
        });
};

module.exports = Uploader;
