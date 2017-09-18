
angular.module('bachmans-common')
    .factory('bachBuyerXp', bachBuyerXpService)
;

function bachBuyerXpService($q, $http, $interval, nodeapiurl){
    var buyerxpurl = nodeapiurl + '/buyerxp';
    var buyerxp = null;
    var hasBeenCalled = false;
    var service = {
        Get: _get,
        GetCache: _getCache,
        Update: _update,
        Patch: _patch
    };

    function _get(token){
        var dfd = $q.defer();

        if(buyerxp){
            dfd.resolve(buyerxp);
        } else if(hasBeenCalled){
            waitForResponse();
        } else {
            hasBeenCalled = true;
            $http.get(buyerxpurl, {headers: {'oc-token': token}})
                .then(function(response){
                    buyerxp = {xp: response.data};
                    dfd.resolve(buyerxp);
                })
                .catch(function(ex){
                    dfd.reject(ex);
                });
            }

        function waitForResponse(){
            var check = $interval(function(){
                if(buyerxp){
                    $interval.cancel(check);
                    dfd.resolve(buyerxp);
                }
            }, 100);
        }

        return dfd.promise;
    }

    function _getCache(){
        //don't use this in resolve, may not be set yet
        return buyerxp;
    }

    function _update(token, update){
        return $http.put(buyerxpurl, update, {headers: {'oc-token': token}})
            .then(function(response){
                buyerxp = {xp: response.data};
                return buyerxp;
            });   
    }

    function _patch(patch, token){
        return $http.patch(buyerxpurl, patch, {headers: {'oc-token': token}})
            .then(function(response){
                buyerxp = {xp: response.data};
                return buyerxp;
            });   
        
    }

    return service;
}