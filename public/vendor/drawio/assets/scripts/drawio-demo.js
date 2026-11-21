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
    // 原生菜单/快捷键里的「保存 / 另存为」接回宿主页面
    // （demo 壳没有后端文件服务，否则点击 saveFile 无任何反应）
    try {
      editorUIInstance.actions.addAction('save', function() {
        window.parent.postMessage({ eventName: 'requestSave' }, '*');
      }, null, null, 'Ctrl+S');
      editorUIInstance.actions.addAction('saveAs...', function() {
        window.parent.postMessage({ eventName: 'requestDownload' }, '*');
      }, null, null, 'Ctrl+Shift+S');
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

function drawioDiagramElements(doc) {
  var root = doc && doc.documentElement;
  if (!root || root.nodeName !== 'mxfile') return [];
  var list = [];
  for (var n = root.firstChild; n; n = n.nextSibling) {
    if (n.nodeType === 1 && n.nodeName === 'diagram') list.push(n);
  }
  return list;
}

function drawioDiagramModel(diagram) {
  if (!diagram) throw new Error('页面不存在');
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

function drawioFirstDiagramModel(doc) {
  var root = doc.documentElement;
  if (!root) throw new Error('文件为空');
  if (root.nodeName === 'mxGraphModel') return root;
  if (root.nodeName !== 'mxfile') throw new Error('不支持的文件格式: ' + root.nodeName);
  return drawioDiagramModel(drawioDiagramElements(doc)[0]);
}

// 加载 .drawio：pageIndex 指定显示第几页（多页文件支持切换）
function loadDrawioFile(xml, fallbackName, pageIndex) {
  var doc = mxUtils.parseXml(xml);
  if (!doc.documentElement || doc.documentElement.nodeName === 'parsererror') {
    throw new Error('XML 解析失败');
  }
  var diagrams = drawioDiagramElements(doc);
  var idx = Math.max(0, Math.min(Number(pageIndex) || 0, Math.max(0, diagrams.length - 1)));
  var diagram = diagrams[idx] || null;
  var model = diagram ? drawioDiagramModel(diagram) : drawioFirstDiagramModel(doc);
  window.__drawioFile = {
    doc: diagrams.length ? doc : null,  // 保留原文档以保留多页/属性，保存时只回写当前页
    index: idx,
    name: (diagram && diagram.getAttribute('name')) || fallbackName || 'Page-1',
  };
  window.__drawioSuppressChange = true;
  try {
    editorUIInstance.editor.setGraphXml(null);
    // importGraphModel 会用 mxCodec 扫描「整个 ownerDocument」，
    // 多页 .drawio 里各页单元格 id 重复（0/1/2…）会抛 "xx: Duplicate ID"。
    // 因此把当前页的 mxGraphModel 重新序列化成独立文档再导入。
    var isolated = mxUtils.parseXml(mxUtils.getXml(model));
    editorUIInstance.editor.graph.importGraphModel(isolated.documentElement);
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
  var diagrams = drawioDiagramElements(doc);
  var diagram = diagrams[state.index || 0] || diagrams[0];
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
          loadDrawioFile(event.data.value || '', event.data.name, event.data.pageIndex);
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
