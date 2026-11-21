// Extends EditorUi to update I/O action states based on availability of backend
(function()
{
	var editorUiInit = EditorUi.prototype.init;
	
	EditorUi.prototype.init = function()
	{
		editorUiInit.apply(this, arguments);
	};
	
	// Adds required resources (disables loading of fallback properties, this can only
	// be used if we know that all keys are defined in the language specific file)
	mxResources.loadDefaultBundle = false;
	var bundle = './assets/drawio_lib/resources/' + mxLanguage + '.txt';
	
	// Fixes possible asynchronous requests
	mxUtils.getAll([bundle, './assets/drawio_lib/theme/default.xml'], function(xhr)
	{
		// Adds bundle text to resources
		mxResources.parse(xhr[0].getText());
		
		// Configures the default graph theme
		var themes = new Object();
		themes[Graph.prototype.defaultThemeName] = xhr[1].getDocumentElement(); 
		
		// Main
    window.editorUIInstance = new EditorUi(new Editor(false, themes));
    
    try {
      addPostMessageListener(editorUIInstance.editor);
    } catch (error) {
      console.log(error);
    }
    // 画布变更通知（供 .drawio 文件页做自动保存）
    try {
      editorUIInstance.editor.graph.getModel().addListener(mxEvent.CHANGE, function() {
        if (window.__drawioSuppressChange) return;
        var now = Date.now();
        if (now - (window.__drawioLastChange || 0) < 300) return;
        window.__drawioLastChange = now;
        window.parent.postMessage({ eventName: 'changed' }, '*');
      });
    } catch (error) {
      console.log(error);
    }
    window.parent.postMessage({eventName: 'ready', value: ''}, '*');

	}, function()
	{
		document.body.innerHTML = '<center style="margin-top:10%;">Error loading resource files. Please check browser console.</center>';
	});
})();

// ---------- .drawio 原生文件（<mxfile> / 压缩 diagram / 多页）支持 ----------
// draw.io 文件格式：<mxfile><diagram>…</diagram></mxfile>
// diagram 内容可能是未压缩 <mxGraphModel>，也可能是 base64(deflateRaw(encodeURIComponent(xml)))
function drawioBytesFromBase64(text) {
  // 该 mxClient 版本没有 mxUtils.base64decode；drawio 自己的 Base64 编码是标准 base64
  var raw = typeof atob === 'function' ? atob(text) : mxUtils.base64decode(text);
  var arr = new Uint8Array(raw.length);
  for (var i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
  return arr;
}

function drawioFirstDiagramModel(doc) {
  var root = doc.documentElement;
  if (!root) throw new Error('文件为空');
  if (root.nodeName === 'mxGraphModel') return root;
  if (root.nodeName !== 'mxfile') throw new Error('不支持的文件格式: ' + root.nodeName);
  var diagram = root.getElementsByTagName('diagram')[0];
  if (!diagram) throw new Error('文件中没有 diagram 页面');
  var inline = diagram.getElementsByTagName('mxGraphModel')[0];
  if (inline) return inline;
  var text = (diagram.textContent || '').replace(/\s+/g, '');
  if (!text) throw new Error('diagram 页面内容为空');
  var inflated;
  try {
    inflated = pako.inflateRaw(drawioBytesFromBase64(text), { to: 'string' });
  } catch (e) {
    throw new Error('无法解析压缩的 diagram: ' + e.message);
  }
  return mxUtils.parseXml(decodeURIComponent(inflated)).documentElement;
}

function loadDrawioFile(xml, fallbackName) {
  var doc = mxUtils.parseXml(xml);
  if (!doc.documentElement || doc.documentElement.nodeName === 'parsererror') {
    throw new Error('XML 解析失败');
  }
  var model = drawioFirstDiagramModel(doc);
  var diagram = doc.documentElement.nodeName === 'mxfile' ? doc.getElementsByTagName('diagram')[0] : null;
  window.__drawioFile = {
    doc: diagram ? doc : null,  // 保留原文档以保留多页/属性，保存时只回写第一页
    name: (diagram && diagram.getAttribute('name')) || fallbackName || 'Page-1',
  };
  window.__drawioSuppressChange = true;
  try {
    editorUIInstance.editor.setGraphXml(null);
    editorUIInstance.editor.graph.importGraphModel(model);
    editorUIInstance.editor.setFilename(window.__drawioFile.name);
  } finally {
    window.__drawioSuppressChange = false;
  }
}

function serializeDrawioFile() {
  var modelXml = mxUtils.getXml(editorUIInstance.editor.getGraphXml());
  var state = window.__drawioFile;
  if (!state || !state.doc) return modelXml;
  var doc = state.doc;
  var diagram = doc.getElementsByTagName('diagram')[0];
  if (!diagram) return modelXml;
  while (diagram.firstChild) diagram.removeChild(diagram.firstChild);
  var modelDoc = mxUtils.parseXml(modelXml);
  diagram.appendChild(doc.importNode(modelDoc.documentElement, true));
  return mxUtils.getXml(doc);
}

function addPostMessageListener(graphEditor) {
  window.addEventListener('message', function(event) {
    if(!event.data || !event.data.eventName) {
        return 
    }
    switch (event.data.eventName) {
      case 'setData':
        var value = event.data.value;
        // 新建图表时 Cherry 传空串：直接清空画布，避免 parseXml('') 触发 mxCodec 告警
        editorUIInstance.editor.setGraphXml(null);
        if (value) {
          try {
            var doc = mxUtils.parseXml(value);
            if (!doc.documentElement || doc.documentElement.nodeName === 'parsererror') {
              throw new Error('invalid xml: ' + String(value).slice(0, 120));
            }
            graphEditor.graph.importGraphModel(doc.documentElement);
          } catch (error) {
            // 历史版本曾以错误编码写入 data-xml（decodeURI 无法还原 encodeURIComponent），
            // 解析失败时保持空画布并告警，绝不让 message 监听器静默抛错挂起
            console.warn('[drawio] setData 解析失败，画布保持为空:', error);
          }
        }
        var documentName = 'cherry-drawio-' + new Date().getTime();
        graphEditor.setFilename(documentName);
        window.parent.postMessage({eventName: 'setData:success', value: ''}, '*');
        break;
      case 'getData':
        editorUIInstance.editor.graph.stopEditing();
        var xmlData = mxUtils.getXml(editorUIInstance.editor.getGraphXml());
        editorUIInstance.exportImage(1, "#ffffff", true, null, true, 50, null, "png", function(base64, filename){
          window.parent.postMessage({
            mceAction: 'getData:success',
            eventName: 'getData:success',
            value: {
              xmlData: xmlData,
              base64: base64,
            }
          }, '*');
        })
        break;
      case 'setFileData':
        try {
          loadDrawioFile(event.data.value || '', event.data.name);
          window.parent.postMessage({ eventName: 'setFileData:success', value: '' }, '*');
        } catch (error) {
          console.warn('[drawio] setFileData 失败:', error);
          window.parent.postMessage({ eventName: 'setFileData:error', value: String((error && error.message) || error) }, '*');
        }
        break;
      case 'getFileData':
        try {
          window.parent.postMessage({ eventName: 'getFileData:success', value: { xmlData: serializeDrawioFile() } }, '*');
        } catch (error) {
          window.parent.postMessage({ eventName: 'getFileData:error', value: String((error && error.message) || error) }, '*');
        }
        break;
      case 'ready?':
        window.parent.postMessage({eventName: 'ready', value: ''}, '*');
        break;
      default:
        break;
    }
  }); 
}
