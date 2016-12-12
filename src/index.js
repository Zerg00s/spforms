"use strict";
var fs = require('fs');
var path = require('path');
var csomapi = require('csom-node');
var deferred = require('deferred');
var ncp = require('ncp').ncp;
var camelCase = require('lodash.camelcase');
var html = require('html');
var urljoin = require('url-join');

var spforms = spforms || {};

String.prototype.format = function(placeholders) {
    var s = this;
    for(var propertyName in placeholders) {
        var re = new RegExp('{' + propertyName + '}', 'gm');
        s = s.replace(re, placeholders[propertyName]);
    }    
    return s;
};


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
        .then(function(fields){
           var AngularView = _self.generateFields(fields);
            //console.log(AngularView);
            //TODO: generate JSON with all field types like Ivan proposed?

            _self.copyForms(listSettings, (generatedHtmlPath, fieldsFile) => {
                var angularViewFilePath = path.join(listSettings.sourcePath, fieldsFile);
                fs.writeFile(angularViewFilePath, AngularView, 'utf8', function (err) {
                    if (err) return console.log(err);
                });
                
                listSettings.contentLink = urljoin(listSettings.siteUrl, listSettings.assetsUrl, generatedHtmlPath);
                _self.addCEWP2LitstForms(listSettings);
            });

        })
        .catch(function(error){
            console.log(error);
        })
    }

    _self.generateFields = function(fields){

        let AngularStringTemplate = "<div class='col-md-4'><!--{DisplayName} | Type: {Type} --><h4>{{f.{Name}.FieldDisplayName}}</h4>{angularField}</div>";

        let AngularNoteField     = "<textarea        name='{Name}' id='{Name}' ng-model='f.{Name}.Value'></textarea>";
        let AngularTextField     = "<input           name='{Name}' id='{Name}' ng-model='f.{Name}.Value' type='text'  class='full-width' />";
        let AngularNumberField   = "<input           name='{Name}' id='{Name}' ng-model='f.{Name}.Value' type='number' min='0' />";
        let AngularTimeField     = "<input           name='{Name}' id='{Name}' ng-model='f.{Name}.Value' type='time'/>";
        let AngularDateTimeField = "<datetime-picker name='{Name}' id='{Name}' ng-model='f.{Name}.Value' format='calendarFormat'  />";
        let AngularBooleanField  = "<input           name='{Name}' id='{Name}' ng-model='f.{Name}.Value' type='checkbox' />";
        let AngularUserField     = "<div             name='{Name}' id='{Name}' ng-model='f.{Name}.user' ui-people pp-is-multiuser='{{false}}' pp-width='220px' pp-account-type='User,DL,SecGroup,SPGroup'> </div>";
        let AngularChoiceField   = "<choice-field    name='{Name}' id='{Name}' field='f.{Name}' class='choice-field'> </choice-field>";
        let AngularRadioField    = "<radio-field     name='{Name}' id='{Name}' field='f.{Name}'></choice-field>";		
        //TODO: AngularLookupField:

         let AngularView = '';
         for(var field in fields){
             if(fields[field].ReadOnlyField == true){
                 continue;
             }
             let angularField = '';
             switch (fields[field].FieldType)
             {
                 case "Text":
                    angularField = AngularTextField.format({Name: fields[field].FieldInternalName})
                 break;
                 case "Note":
                     angularField = AngularNoteField.format({Name: fields[field].FieldInternalName})
                 break;
                 case "Number":
                     angularField = AngularNumberField.format({Name: fields[field].FieldInternalName})
                 break;
                 case "Choice":
                     angularField = AngularChoiceField.format({Name: fields[field].FieldInternalName})
                 break;
                 case "Radio":
                     angularField = AngularRadioField.format({Name: fields[field].FieldInternalName})
                 break;
                 case "DateTime":
                     angularField = AngularDateTimeField.format({Name: fields[field].FieldInternalName})
                 break;
                 case "Time":
                     angularField = AngularTimeField.format({Name: fields[field].FieldInternalName})
                 break;
                 case "User":
                     angularField = AngularUserField.format({Name: fields[field].FieldInternalName})
                 break;
                 case "Boolean":
                     angularField = AngularBooleanField.format({Name: fields[field].FieldInternalName})
                 break;
                 //TODO: Lookup:

             }

             angularField = AngularStringTemplate.format(
                 {
                     DisplayName:fields[field].FieldDisplayName,
                     Type:fields[field].FieldType, 
                     Name:fields[field].FieldInternalName,
                     angularField: angularField 
                });

            AngularView += html.prettyPrint(angularField);
        }

        return AngularView;
    }

    //Copy scaffolding for the Angular forms.
    //Copy all files if not copied
    _self.copyForms = function(copySettings, callbackFunction) {
        ncp('./node_modules/spforms/src/Templates/App', path.join(copySettings.sourcePath, '/App'), {clobber:false}, function (err) {
            if (err) {
                return console.error(err);
            }

            var listFormFolderName = camelCase(copySettings.listTitle);

            var listFormFolder = path.join(copySettings.sourcePath, 'App/forms',listFormFolderName);

            ncp(//Copy Folder:
                path.join(copySettings.sourcePath, '/App/forms/SampleForm'), 
                listFormFolder,
                { clobber:false },
                _=>{ 
                    //onFolderCopied:
                    fs.readdir(listFormFolder, (err, files) => {
                        files.forEach(file => {
                            let oldFilePath = path.join(listFormFolder, file);
                            let newFilePath = path.join(listFormFolder, file.replace('sample', listFormFolderName));
                            fs.rename(oldFilePath, newFilePath,  _=> {
                                let replacementSettings = copySettings;
                                replacementSettings.file = newFilePath;
                                _self.replaceTokensInFile(copySettings);   

                                if(file.indexOf('Fields') != -1){
                                    var listFormHtml = path.join('App/forms/',listFormFolderName, listFormFolderName +'Form.html');
                                    var listFormFields = path.join('App/forms/',listFormFolderName, listFormFolderName +'Fields.html');
                                    callbackFunction(listFormHtml, listFormFields);
                                }
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
        tokens2Replace.set(/DEPLOYMENT_FOLDER/g, replacementSettings.assetsUrl);
        tokens2Replace.set(/LIST_TITLE/g, replacementSettings.listTitle);
        tokens2Replace.set(/LIST_NAME/g, camelCase(replacementSettings.listTitle));    
        tokens2Replace.set(/ParentItemID/g, camelCase(replacementSettings.listTitle));
        
        var epta = replacementSettings.file;

        var data = fs.readFileSync(epta, 'utf8');
           
        tokens2Replace.forEach(function(value, key) {
            data  = data.replace(key, value);
        });

        fs.writeFileSync(epta, data, 'utf8');
    }

    //Get SP Lists
    _self.getLists = function(siteSettings){
        var credentialOptions = {
            'username': _self.settings.username,
            'password': _self.settings.password,
        };
        
        var spr = require('sp-request').create(credentialOptions);

        var listsUrl = siteSettings.siteUrl +
         "/_api/Web/Lists"+
         "?$filter=IsCatalog eq false" +
         " and Hidden eq false"+
         " and BaseType ne 1" // <-- excludes Libraries 
         "&$select=Title";
        
        return spr.get(listsUrl)
        .then(function (response) {
            var expludedLists = [
                'Content and Structure Reports',
                'Form Templates',
                'MicroFeed',
                'Reusable Content',
                'Site Collection Documents',
                'Site Collection Images',
                'Site Pages',
                'Pages',
                'Workflow Tasks'
                ]; 
            var lists = [];
            var results = response.body.d.results;
            for (var x = 0; x < results.length; x++) {
                if(expludedLists.indexOf(results[x].Title) == -1){
                    lists.push(results[x].Title);
                }
            }
            //returning data to the promise
            return lists;
        })
        .catch(function(err){
            console.log(err);
        });
    }

    _self.checkIfAttachmentsExist = function(siteSettings){
        var credentialOptions = {
            'username': _self.settings.username,
            'password': _self.settings.password,
        };
        
        var spr = require('sp-request').create(credentialOptions);
        var listsUrl = siteSettings.siteUrl + "/_api/Web/Lists/Attachments";
        
        return spr.get(listsUrl)
        .then(function (response) {
            var results = response.body.d.results;
            //returning data to the promise:
            return true;
        })
        .catch(function(err){
            console.log(err);
        });
    }

    _self.getListId = function(siteSettings, listSettings){
        var credentialOptions = {
            'username': _self.settings.username,
            'password': _self.settings.password,
        };
         var spr = require('sp-request').create(credentialOptions);
         return spr.requestDigest(siteSettings.siteUrl)
        .then(function (digest) {
            var listIdUrl = urljoin(siteSettings.siteUrl,  "/_api/web/lists/getbytitle('"+listSettings.listTitle+"')?$select=Id");
            
            return spr.get(listIdUrl).then(function(response){
                listSettings.listId = response.body.d.Id;
                return listSettings;
            });
        });
    }

    _self.addAttachmentField = function(siteSettings, listSettings){
        var credentialOptions = {
            'username': _self.settings.username,
            'password': _self.settings.password,
        };
        
        var spr = require('sp-request').create(credentialOptions);
         return spr.requestDigest(siteSettings.siteUrl)
        .then(function (digest) {
            return spr.post(siteSettings.siteUrl + "/_api/Web/Lists/Attachments/fields/addfield", 
            {
                body: { 
                    'parameters':{
                        '__metadata': { 'type': 'SP.FieldCreationInformation' }, 
                        'FieldTypeKind': 7, 
                        'Title': camelCase(replacementSettings.listTitle),
                        'LookupFieldName':'Title',//TODO: It's safer to use ID than TItle
                        'LookupListId': listSettings.listId 
                        //TODO: add cascading delete
                    }
                },
                headers: {
                    'X-RequestDigest': digest
                }
            });
        });
    }

    _self.createList = function(siteSettings, listSettings){

        var credentialOptions = {
            'username': _self.settings.username,
            'password': _self.settings.password,
        };
        
        var spr = require('sp-request').create(credentialOptions);

        return spr.requestDigest(siteSettings.siteUrl)
        .then(function (digest) {
            return spr.post(siteSettings.siteUrl + "/_api/Web/Lists", 
                {
                    body: { 
                        '__metadata': { 'type': 'SP.List' }, 
                        'AllowContentTypes': true,
                        'BaseTemplate': 101,
                        'ContentTypesEnabled': false,
                        'Description': '',
                        'Title': 'Attachments'
                    },
                    headers: {
                        'X-RequestDigest': digest
                    }
                });

        })
        .then(function (response) {
            if (response.statusCode === 204) {
                console.log('Attachments created!');
            }
        }, function (err) {
            if (err.statusCode === 500) {
                console.log('Attachments Library already exists');
            } else {
                console.log(err);
            }
        }) 
        .then(_=>{
            return _self.getListId(siteSettings, listSettings);
        }) 
        .then(function(listSettings){
            return _self.addAttachmentField(siteSettings, listSettings);
        });
    }

    return _self;
}

module.exports = spforms.init;