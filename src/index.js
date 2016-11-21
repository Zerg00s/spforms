"use strict";
var fs = require('fs');
var path = require('path');
var csomapi = require('csom-node');
var deferred = require('deferred');
var ncp = require('ncp').ncp;
var camelCase = require('lodash.camelcase');

var spforms = spforms || {};

spforms.init = function(settings) {
    var _self = {};
    _self.settings = settings;

    // Add CEWP to all List forms 
    _self.addCEWP2LitstForms = function(webPartSettings) {
        var siteRelativeUrl = '/' +  webPartSettings.siteUrl.replace(/^(?:\/\/|[^\/]+)*\//, "");

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
    };// addCEWP2ListForms end

    //Get SP Fields from the list
    _self.getListFields = function(listSettings){
        var credentialOptions = {
            'username': _self.settings.username,
            'password': _self.settings.password,
        };

        function initializeField(result) {
            var retVal = {};
            retVal.Id = result.Id;
            retVal.FieldDisplayName = result.Title;
            retVal.FieldInternalName = result.InternalName;
            retVal.FieldType = result.TypeAsString;
            retVal.Required = result.Required;
            retVal.ReadOnlyField = result.ReadOnlyField;
            if (result.Choices) {
                retVal.Choices = result.Choices.results;
            }
            //TODO: handle multichoice
            //TODO: handle lookups
            //TODO: handle taxonomy

            return retVal;
        };

        var spr = require('sp-request').create(credentialOptions);

        var listFieldsUrl = listSettings.siteUrl +
         "/_api/web/lists/GetByTitle('" + listSettings.listTitle + "')/fields?$filter=Hidden eq false";
        
        return spr.get(listFieldsUrl)
        .then(function (response) {
            var results = response.body.d.results;
            var f = {};
            for (var x = 0; x < results.length; x++) {
                if (!results[x].Hidden) {
                    if (results[x].InternalName != 'ContentType') {
                        if (results[x].InternalName != 'Attachments') {
                            var field = initializeField(results[x]);
                            f[results[x].InternalName] = field;                
                        }
                    }
                }
            }
            //returning data to the promise
            return f;
        })
        .catch(function(err){
            console.log(err);
        });
    }

    //Read SharePoint list metadata and generate JSON file based on it
    _self.generateAngularForm = function(listSettings){
        _self.getListFields(listSettings)
        .then(function(){
            //TODO: generate JSON with all field types?
        })
        .catch(function(error){
            console.log(error);
        })
    }

    //Copy scaffolding for the Angular forms.
    //Copy all files if not copied
    _self.copyForms = function(copySettings) {
        ncp('./node_modules/spforms/src/Templates/App', copySettings.destinationFolder,{clobber:false}, function (err) {
            if (err) {
                return console.error(err);
            }

            var listFormFolderName = camelCase(copySettings.listTitle);

            var listFormFolder = copySettings.destinationFolder + '/forms/' + listFormFolderName;

            ncp(//Copy Folder:
                copySettings.destinationFolder + '/forms/SampleForm', 
                listFormFolder,
                { clobber:false },
                _=>{ 
                    //onFolderCopied:
                    fs.readdir(listFormFolder, (err, files) => {
                        files.forEach(file => {
                            let oldFilePath = listFormFolder +'/' + file;
                            let newFilePath = listFormFolder +'/' + file.replace('sample', listFormFolderName);
                            fs.rename(oldFilePath, newFilePath,  _=>{
                                let replacementSettings = copySettings;
                                replacementSettings.file = newFilePath;
                                _self.replaceTokensInFile(copySettings);   
                            }
                            );
                        });
                    });
                }
            );

            
        });
    }

    _self.replaceTokensInFile = function(replacementSettings){
        if(replacementSettings.file.indexOf('sample') != -1){
            return;
        }

        var tokens2Replace = new Map(); 
        tokens2Replace.set(/DEPLOYMENT_FOLDER/g, replacementSettings.deploymentFolder);
        tokens2Replace.set(/LIST_TITLE/g, replacementSettings.listTitle);
        tokens2Replace.set(/LIST_NAME/g, camelCase(replacementSettings.listTitle));    
        
        var epta = replacementSettings.file;

        var data = fs.readFileSync(epta, 'utf8');
           
        tokens2Replace.forEach(function(value, key) {
            data  = data.replace(key, value);
        });

        fs.writeFileSync(epta, data, 'utf8');
    }

    return _self;
}




module.exports = spforms.init;