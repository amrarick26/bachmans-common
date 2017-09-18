angular.module('bachmans-common')
    .factory('bachShipments', bachShipmentsService)
;

function bachShipmentsService($q, buyerid, OrderCloudSDK, bachWiredOrders, bachBuyerXp, $resource, nodeapiurl, appname){
    var isSF = appname === 'BachmanStoreFront';
    var service = {
        Group: _group,
        GroupAndPatchLIs: _groupAndPatchLIs, //patches li.xp.Destination and li.xp.deliveryFeesDtls
        Create: _create,
        List: _list
    };

    function _group(lineitems){
       var initialGrouping = _.groupBy(lineitems, function(lineitem){

            var recipient = '';
            var shipto = '';
            if(lineitem.ShippingAddress){
                // every line item with a unique recipient must be a unique shipment
                recipient = (lineitem.ShippingAddress.FirstName + lineitem.ShippingAddress.LastName).replace(/ /g, '').toLowerCase();

                // every line item with a unique ship to address must be a unique shipment
                shipto = _.values(_.pick(lineitem.ShippingAddress, 'Street1', 'Street2', 'City', 'State', 'Zip', 'Country')).join('').replace(/ /g, '').toLowerCase();
            }
            
            // every line item with a unique requested delivery date must be a unique shipment
            var deliverydate = lineitem.xp.DeliveryDate || '';

            // group line items together if they are wired order - they will be further segmented later
            var wiredorder = lineitem.xp.Destination && _.contains(['T', 'F', 'E'], lineitem.xp.Destination);

            // every line item with a unique delivery method must be a unique shipment
            var deliverymethod = lineitem.xp.DeliveryMethod || '';

            var status = lineitem.xp.Status || 'Open';

            return recipient + shipto + deliverydate + deliverymethod + status + wiredorder;
        });
        return splitByProductFromStore(_.values(initialGrouping));
    }

    function splitByProductFromStore(shipments){
        // if shipment has xp.DeliveryMethod = InStorePickup then split shipment by xp.ProductFromStore
        var splitShipments = [];
        _.each(shipments, function(shipment){
            var hasInstorePickup = _.filter(shipment, function(li){
                return _.some(li.xp, {DeliveryMethod: 'InStorePickup'});
            });
            var grouped = _.groupBy(shipment, function(lineitem){
                if(hasInstorePickup){
                    return lineitem.xp.ProductFromStore;
                } else {
                    return;
                }
            });
            _.each(grouped, function(shipment){
                splitShipments.push(shipment);
            });
        });
        return splitByEvents(splitShipments);
    }

    function splitByEvents(shipments){
        // events are always a unique shipment
        _.each(shipments, function(shipment, sindex){
            _.each(shipment, function(lineitem, lindex){
                if(lineitem.Product.xp.isEvent && shipment.length > 1){
                    //splice event line items out of a shipment and into their own shipment
                    var event = shipments[sindex].splice(lindex, 1);
                    shipments.push(event);
                }
            });
        });
        return splitWiredOrders(shipments);
    }

    function splitWiredOrders(shipments){
        var splitShipments = [];
        _.each(shipments, function(shipment){
            var wiredOrderSettings = bachBuyerXp.GetCache().xp.wireOrder.OutgoingOrders;
            bachWiredOrders.DetermineEithers(shipment, wiredOrderSettings); //sets F or T for all li.xp.Destination
            
            var grouped = _.groupBy(shipment, function(li){
                return li.xp.Destination;
            });
            _.each(grouped, function(group, destination){
                var isWiredShipment = destination === 'F' || destination === 'T';
                if(isWiredShipment){
                    _.each(group, function(li){
                        
                        _.each(li.xp.deliveryFeesDtls, function(charge, type){
                            var standardDeliveryCharges = [
                                'LocalDelivery', 
                                'Standard Delivery', 
                                'InStorePickUp', 
                                'Courier', 
                                'USPS',
                                'UPS Charges', 
                                'Event'
                            ];
                            if(_.contains(standardDeliveryCharges, type)){
                                //wired line items should not have standard delivery charges
                                li.xp.deliveryFeesDtls[type] = 0; //set to 0 so we can avoid update and use patch
                            }
                                //clear any previous charges
                            if(_.contains(['Wired Delivery Charges'], ['Wired Service Charges'])){
                                li.xp.deliveryFeesDtls[type] = 0;
                            }
                        });

                        //put wired order charges on only the first line item in a shipment
                        if(!shipment[0].xp.deliveryFeesDtls) shipment[0].xp.deliveryFeesDtls = {};
                        shipment[0].xp.deliveryFeesDtls['Wired Delivery Charges'] = Number(wiredOrderSettings.WiredDeliveryFees);
                        shipment[0].xp.deliveryFeesDtls['Wired Service Charges'] = Number(wiredOrderSettings.WiredServiceFees);
                    });
                }
                splitShipments.push(group);
            });
        });
        return shipmentTotals(splitShipments);
    }

    function shipmentTotals(shipments){
        _.each(shipments, function(shipment){
            shipment.Cost = 0;
            shipment.Tax = 0;
            shipment.deliveryFeesDtls = {}; //cumulative unique delivery fees details object

            var standardDeliveryCharges = 0;
            var wiredCharges = 0;
            var nonDeliveryCharges = 0;

            _.each(shipment, function(li){
                if(li.xp) {
                    li.xp.Tax = li.xp.Tax || 0;
                    shipment.Cost = add(shipment.Cost, li.LineTotal);
                    shipment.Tax = add(shipment.Tax, li.xp.Tax);
                }

                _.each(li.xp.deliveryFeesDtls, function(charge, type){

                    if(_.contains(['LocalDelivery', 'Standard Delivery', 'InStorePickUp', 'Courier', 'USPS', 'UPS Charges', 'Event'], type)){
                        standardDeliveryCharges = add(standardDeliveryCharges, charge);
                    } else if(_.contains(['Wired Delivery Charges', 'Wired Service Charges'], type)){
                        wiredCharges = add(wiredCharges, charge);
                    } else {
                        nonDeliveryCharges = add(nonDeliveryCharges, charge);
                    }

                    //build up shipment level deliveryFeesDtls object
                    if(!shipment.deliveryFeesDtls[type]){
                        //fee type doesn't exist - create it and set it to first val
                        shipment.deliveryFeesDtls[type] = charge;
                    } else {
                        //fee type already exists - add to it
                        shipment.deliveryFeesDtls[type] = add(shipment.deliveryFeesDtls[type], charge);
                    }
                });
            });

            //only either wired delivery charges OR standard delivery charges should apply - never both
            shipment.DeliveryCharges = nonDeliveryCharges + (wiredCharges || standardDeliveryCharges); 
            shipment.Total = add(shipment.Cost, shipment.Tax, shipment.DeliveryCharges);
        });
        return shipments;
    }

    function _groupAndPatchLIs(lineitemList, orderID){
        var shipments = _group(lineitemList);
        var lineitems = _.flatten(shipments);
        _.each(lineitems, function(li){
            if(li.xp.Destination === 'F' || li.xp.Destination === 'T'){
                //this can just lazy-update in the background (don't need return results, just updating on OC)
                OrderCloudSDK.LineItems.Patch(isSF ? 'outgoing' : 'incoming', orderID, li.ID, {xp: {deliveryFeesDtls: li.xp.deliveryFeesDtls}});
            }
        });
        return shipments;
    }

    function _create(lineitems, order){
        var shipments = _groupAndPatchLIs(lineitems);

        var shipmentsQueue = [];
        _.each(shipments, function(shipment, index){

            var items = [];
            _.each(shipment, function(lineitem){
                items.push({
                    'OrderID': order.ID,
                    'LineItemID': lineitem.ID,
                    'QuantityShipped': lineitem.Quantity
                });
            });
            
            var count = index + 1;
            var li = shipment[0];
            var isAnon = order.FromUserID === 'anon-template-user';

            var shipmentObj = {
                'BuyerID': buyerid,
                'ID': order.ID + '-' + (count < 10 ? '0' : '') + count,
                'DateDelivered': null, // is set by integration once order is actually delivered
                'Cost': shipment.Cost, //cumulative li.LineTotal for all li in this shipment
                'Items': items,
                'xp': {
                    'Status': status(li),
                    'PrintStatus': printStatus(li),
                    'Direction': 'Outgoing', //will always be outgoing if set from app
                    'DeliveryMethod': deliveryMethod(li), //possible values: FTD, TFE, LocalDelivery, InStorePickUp, Courier, USPS, UPS, Event
                    'DateSubmitted': formatDate(order.DateSubmitted),
                    'RequestedDeliveryDate': formatDate(li.xp.DeliveryDate),
                    'addressType': li.xp.addressType, //possible values: Residence, Funeral, Cemetary, Church, School, Hospital, Business, InStorePickUp
                    'RecipientName': li.ShippingAddress.FirstName + ' ' + li.ShippingAddress.LastName,
                    'SenderName': isAnon ? order.BillingAddress.FirstName + ' ' + order.BillingAddress.LastName : order.FromUser.FirstName + ' ' + order.FromUser.LastName,
                    'FromUserID': order.FromUserID,
                    'CSRID': order.xp.CSRID || 'Web', //will be populated if placed on OMS
                    'Tax': shipment.Tax, //cumulative li.xp.Tax for all li in this shipment
                    'DeliveryCharges': shipment.DeliveryCharges,
                    'RouteCode': li.xp.RouteCode, //alphanumeric code of the city its going to - determines which staging area product gets set to,
                    'TimePreference': li.xp.deliveryRun || 'NO PREF', // when customer prefers to receive order,
                    'ShipTo': li.ShippingAddress
                }
            };
            
            shipmentsQueue.push(nodeShipmentCreate(order.ID, shipmentObj));
        });

        return $q.all(shipmentsQueue);
    }

    function nodeShipmentCreate(orderID, shipmentObj){
        var body = {
            orderID: orderID,
            Shipment: shipmentObj
        };
        return $resource(nodeapiurl + '/shipments/create', {}, {
            call: {
                method: 'POST', 
                headers: {
                    'oc-token': OrderCloudSDK.GetToken()
                }
            }
        }).call(body).$promise;
    }

    function _list(orderID){
        var shipmentItemDictionary = {};
        var filter = {
            pageSize: 100,
            orderID: orderID
        };
        return OrderCloudSDK.Shipments.List(filter)
            .then(function(shipmentList){
                var queue = [];
                _.each(shipmentList.Items, function(shipment){
                    queue.push(function(){
                        return OrderCloudSDK.Shipments.ListItems(shipment.ID)
                            .then(function(shipmentItems){
                                shipment.Items = shipmentItems.Items;
                                _.each(shipmentItems.Items, function(item){
                                    shipmentItemDictionary[item.LineItemID] = item;
                                });
                                return shipment;
                            });
                    }());
                });
                return $q.all(queue)
                    .then(function(shipments){
                        _.each(shipments, function(shipment, shipmentKey){
                            _.each(shipment.Items, function(shipmentItems, itemKey){
                                _.each(shipmentItems.xp.AddExtraLineItemsList, function(addextraID, addExtraKey){
                                    //replace id with actual line item object (easier to access in html)
                                    shipments[shipmentKey].Items[itemKey].xp.AddExtraLineItemsList[addExtraKey] = shipmentItemDictionary[addextraID];
                                });
                            });
                        });
                        return shipments;
                    });
            });
    }

    /* * * Start Internal Functions * * */ 

    function status(li){
        if(li.xp.Destination && _.contains(['F', 'T'], li.xp.Destination)){
            return 'OnHold';
        } else if(li.xp.Status && li.xp.Status === 'OnHold') {
            return 'OnHold';
        } else if(li.xp.addressType && _.contains(['Funeral', 'Church', 'Cemetary'], li.xp.addressType)){
            //these orders are typically difficult to fulfill so CSRs need to see them on hold screen right away
            return 'OnHold';
        } else {
            return 'New';
        }
    }

    function formatDate(datetime){
        if(datetime){
            var date = new Date(datetime);
            return (date.getFullYear() +'-'+ date.getMonth()+ 1 < 10 ? '0' + (date.getMonth() + 1) : date.getMonth() + 1 +'-'+ (date.getDate() < 10 ? '0' + date.getDate() : date.getDate()));
        } else {
            return 'N/A';
        }
    }

    function printStatus(li){
        if( (li.xp.DeliveryMethod === 'LocalDelivery') || ( li.xp.DeliveryMethod === 'InStorePickup' && li.xp.ProductFromStore === 'OtherStore')) {
            return 'NotPrinted';
        } else {
            return 'NotNeeded';
        }
    }

    function deliveryMethod(li){
        if(li.xp && li.xp.Destination && _.contains(['F', 'T'], li.xp.Destination)) {
            return li.xp.Destination === 'F' ? 'FTD' : 'TFE';
        } else {
            return li.xp.DeliveryMethod;
        }
    }

    function add(){
        //adds currency safely by avoiding floating point math
        return _.reduce(arguments, function(a, b){
            return ((a * 100) + (b * 100)) / 100;
        }, 0);
    }

    return service;
}