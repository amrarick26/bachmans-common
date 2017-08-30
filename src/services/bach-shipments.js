angular.module('bachmans-common')
    .factory('bachShipments', bachShipmentsService)
;

function bachShipmentsService($q, buyerid, OrderCloudSDK){
    var service = {
        Group: _group,
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

            // every line item with a unique delivery method must be a unique shipment
            var deliverymethod = lineitem.xp.DeliveryMethod || '';
            
            // every line item with a unique status must be a unique shipment
            // normalize statuses - previously FTDIncoming/Outgoing and TFEIncoming/Outgoing
            if(lineitem.xp.Status && lineitem.xp.Status.indexOf('FTD') > -1) lineitem.xp.Status = 'FTD';
            if(lineitem.xp.Status && lineitem.xp.Status.indexOf('TFE') > -1) lineitem.xp.Status = 'TFE';
            var status = lineitem.xp.Status || 'Open';

            return recipient + shipto + deliverydate + deliverymethod + status;
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
                    var event = shipment[sindex].splice(lindex, 1);
                    shipments.push(event);
                }
            });
        });
        return shipmentTotals(shipments);
    }

    function shipmentTotals(shipments){
        _.each(shipments, function(shipment){
            shipment.Cost = 0;
            shipment.Tax = 0;
            _.each(shipment, function(li){
                if(li && li.xp) {
                    li.xp.Tax = li.xp.Tax || 0;
                    shipment.Cost = ((shipment.Cost * 100) + li.LineTotal * 100) / 100;
                    shipment.Tax = ((shipment.Tax * 100) + li.xp.Tax * 100) / 100;
                }
            });
            shipment.Total = ((shipment.Cost * 100) + (shipment.Tax)) / 100;
        });
        return shipments;
    }

    function _create(lineitems, order, fromSF){
        var shipments = _group(lineitems);

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
                    'DeliveryMethod': li.xp.DeliveryMethod, //possible values: LocalDelivery, FTD, TFE, InStorePickUp, Courier, USPS, UPS, Event
                    'RequestedDeliveryDate': formatDate(li.xp.DeliveryDate),
                    'addressType': li.xp.addressType, //possible values: Residence, Funeral, Cemetary, Church, School, Hospital, Business, InStorePickUp
                    'RecipientName': li.ShippingAddress.FirstName + ' ' + li.ShippingAddress.LastName,
                    'Tax': shipment.Tax, //cumulative li.xp.Tax for all li in this shipment
                    'RouteCode': li.xp.RouteCode, //alphanumeric code of the city its going to - determines which staging area product gets set to,
                    'TimePreference': li.xp.deliveryRun || 'NO PREF', // when customer prefers to receive order,
                    'ShipTo': li.ShippingAddress
                }
            };
            if(fromSF){
                //SF cant't have a shipments decorator (doesnt work with impersonated calls) 
                // so we need to explicitly call save item with impersonated AsAdmin method

                //TODO: consider moving this to an integration so we dont need this hacky workaround
                // and can remove ShipmentAdmin role on SF
                shipmentsQueue.push(function(){
                    return OrderCloudSDK.AsAdmin().Shipments.Create(shipmentObj)
                        .then(function(shipmentResponse){
                            var queue = [];
                            _.each(shipmentObj.Items, function(item){
                                shipmentResponse.Items = [];
                                shipmentResponse.Items.push(item);
                                queue.push(OrderCloudSDK.AsAdmin().Shipments.SaveItem(shipmentResponse.ID, item));
                            });
                            return $q.all(queue)
                                .then(function(){
                                    return shipmentResponse;
                                });
                        });
                }());
            } else {
                shipmentsQueue.push(OrderCloudSDK.Shipments.Create(shipmentObj));
            }
            
        });

        return $q.all(shipmentsQueue);
    }

    /* * * Start Internal Functions * * */ 

    function status(li){
        if(li.xp.DeliveryMethod && (li.xp.DeliveryMethod.indexOf('FTD') > -1 || li.xp.DeliveryMethod.indexOf('TFE') > -1)){
            return 'OnHold';
        } else if(li.xp.Status && li.xp.Status === 'OnHold') {
            return 'OnHold';
        } else if(li.xp.addressType && ['Funeral', 'Church', 'Cemetary'].indexOf(li.xp.addressType) > -1){
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

    return service;
}