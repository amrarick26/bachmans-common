angular.module('bachmans-common')
    .config(lineItemThrottleDecorator)
;

//TODO: this is a temprorary solution to the performance issues described in BAC-778
// Line item list calls will only actually call the API if they are at least 2 seconds apart
// Any calls made closer together than two seconds will share the same response
function lineItemThrottleDecorator($provide) {
    $provide.decorator('OrderCloudSDK', function($delegate, $q, $timeout) {
        var originalLineItemList = $delegate.LineItems.List;
        var currentResponse, isError = false, running = false, cacheResponse = false;

        function newLineItemsList() {
            var df = $q.defer();

            if (running) {
                checkRunning();
            } else if (cacheResponse) {
                complete();
            } else {
                //No list call is currently cached or running so send a new request
                running = true;
                originalLineItemList.apply($delegate, arguments)
                    .then(function(listResponse) {
                        currentResponse = listResponse;
                        isError = false;
                        stopRunning();
                        complete();
                    })
                    .catch(function(ex) {
                        isError = true;
                        stopRunning();
                        complete();
                    });
            }

            function stopRunning() {
                $timeout(function() {
                    cacheResponse = true;
                    newCacheTimer();
                    running = false;
                }, 100);
            }

            function newCacheTimer() {
                //Cache the response for 2 seconds
                $timeout(function() {
                    cacheResponse = false;
                }, 2000);
            }

            function checkRunning() {
                //Wait for the first request to complete and return it's result
                $timeout(function() {
                    running ? checkRunning() : complete();
                }, 100);
            }

            function complete() {
                isError ? df.reject(currentResponse) : df.resolve(currentResponse);
            }

            return df.promise;
        }

        $delegate.LineItems.List = newLineItemsList;
        return $delegate;
    });
}