var fs = require('fs');
var path = require('path');
var csomapi = require('csom-node');
var deferred = require('deferred');

var spr = require('sp-request').create({
        'username': 'user name',
        'password': 'password',
    });

var spforms = spforms || {};

spforms.init = function(settings) {
    var _self = this;
    _self.settings = settings;

    // Add CEWP to all List forms 
    _self.addCEWP2LitstForms = function(webPartSettings) {
        var siteRelativeUrl = str = '/' +  webPartSettings.siteUrl.replace(/^(?:\/\/|[^\/]+)*\//, "");

        csomapi.setLoaderOptions({url: webPartSettings.siteUrl});  //set CSOM library settings
        var authCtx = new AuthenticationContext(webPartSettings.siteUrl);
        authCtx.acquireTokenForUser(_self.settings.username, _self.settings.password, function (authError, data) {

            if(authError){
                console.log(authError);
                return;
            }
            
            //Custom executeQuery that returns a promise! :)
            // you can also pass optional data to the promise
            SP.ClientContext.prototype.executeQuery = function(data) {
                var defer = deferred();
                this.executeQueryAsync(
                    function(){ defer.resolve(data); },
                    function(){ defer.reject(data); }
                );
                return defer.promise;
            };

            var ctx = new SP.ClientContext(siteRelativeUrl);  //set root web
            authCtx.setAuthenticationCookie(ctx);  //authenticate         
            var web = ctx.get_web();

            var list = web.get_lists().getByTitle(webPartSettings.listTitle);
            ctx.load(list, [ // Request extra list properties:
                "DefaultEditFormUrl",
                "DefaultNewFormUrl",
                "DefaultDisplayFormUrl", 
                "Title"]);

            ctx.executeQuery()
            .then( function () {
                var dispForm  = list.get_defaultEditFormUrl();
                var editForm  = list.get_defaultNewFormUrl();
                var newForm   =  list.get_defaultDisplayFormUrl();
                var forms =  [dispForm, editForm, newForm];
                return forms;
            })
            .then(function(forms){
                var webPartColleciton = [];
                forms.forEach(function(form) {
                    var file = web.getFileByServerRelativeUrl(form);
                    var webPartMngr = file.getLimitedWebPartManager(SP.WebParts.PersonalizationScope.shared);
                    var webparts = webPartMngr.get_webParts();
                    ctx.load(webparts); 
                    webPartColleciton.push(webparts);
                });
            
                return ctx.executeQuery({'webparts':webPartColleciton,'forms': forms});  
            })
            .then(function(data) {            
                try{
                    data.webparts.forEach(function(webparts){
                        for(var i = 1; i < webparts.getEnumerator().$8_0.length; i++){
                            var webpart = webparts.get_item(i);
                            webpart.deleteWebPart();
                        }
                    })
                }
                catch(error){
                    console.log(error);
                }
                return ctx.executeQuery(data.forms);
            })
            .then(function(forms) {
                    var webPartXml = '<?xml version="1.0" encoding="utf-8"?>' +
                            '<WebPart xmlns="http://schemas.microsoft.com/WebPart/v2">' +
                                '<Assembly>Microsoft.SharePoint, Version=16.0.0.0, Culture=neutral, PublicKeyToken=71e9bce111e9429c</Assembly>' + 
                                '<TypeName>Microsoft.SharePoint.WebPartPages.ContentEditorWebPart</TypeName>' + 
                                '<Title>Content Editor</Title>' +
                                '<ContentLink xmlns="http://schemas.microsoft.com/WebPart/v2/ContentEditor">'+ webPartSettings.contentLink + '</ContentLink>'+
                                '<Description>$Resources:core,ContentEditorWebPartDescription;</Description>' +
                                '<PartImageLarge>/_layouts/15/images/mscontl.gif</PartImageLarge>' +
                            '</WebPart>';
                    forms.forEach(function(form){
                        var file = web.getFileByServerRelativeUrl(form);
                        var webPartMngr = file.getLimitedWebPartManager(SP.WebParts.PersonalizationScope.shared);
                        var webPartDef = webPartMngr.importWebPart(webPartXml);
                        var webPart = webPartDef.get_webPart();
                        webPartMngr.addWebPart(webPart, 'Main', 1);

                        ctx.load(webPart);

                        ctx.executeQueryAsync(
                            function(info) {
                                // should we return a promise?
                            },
                            function(){console.log('error')}
                        );
                    })

            })// then
            .catch(function(err){
                console.log(err);
            });

            
        });
    };

    return _self;
}


module.exports = spforms.init;