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
    window.parent.postMessage({eventName: 'ready', value: ''}, '*');

	}, function()
	{
		document.body.innerHTML = '<center style="margin-top:10%;">Error loading resource files. Please check browser console.</center>';
	});
})();

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
      case 'ready?':
        window.parent.postMessage({eventName: 'ready', value: ''}, '*');
        break;
      default:
        break;
    }
  }); 
}
