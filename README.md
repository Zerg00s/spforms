# spforms

Sample use (tested with for SharePoint Online):

var spformsHelper = spforms({username:'dmolodtsov@domain.com', password: pass});
    
var webPartSettings = {
    siteUrl: 'https://tenant.sharepoint.com/sites/subsite/',
    listTitle: 'Custom List Title',
    contentLink: 'https://tenant.sharepoint.com/sites/subsite/Assets/App/app.html'
};
//Add content editor webpart to all 3 list item forms:
spformsHelper.addCEWP2LitstForms(webPartSettings);

