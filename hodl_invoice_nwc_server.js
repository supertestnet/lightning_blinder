/*

THESE NEXT LINES ARE CUSTOMIZABLE SETTINGS

*/

var adminmac = ""; //admin macaroon
var lndendpoint = ""; //e.g. https://127.0.0.1:8080 or https://cloud-59.voltage.com

/*

END OF CUSTOMIZABLE SETTINGS - DON'T TOUCH ANYTHING AFTER THIS POINT

*/

var fs = require( 'fs' );
var request = require('request');
var WebSocket = require( 'ws' ).WebSocket;
var nobleSecp256k1 = require( 'noble-secp256k1' );
var crypto = require( 'crypto' );
var bech32 = require( 'bech32' );
var bolt11 = require( 'bolt11' );

var textToHex = text => {
    var encoded = new TextEncoder().encode( text );
    return Array.from( encoded )
        .map( x => x.toString( 16 ).padStart( 2, "0" ) )
        .join( "" );
}

var getInvoiceDescription = invoice => {
    var customNetwork = { bech32: "tbs", pubKeyHash: 63, scriptHash: 123, validWitnessVersions: [ 0, 1 ] }
    if ( !invoice.startsWith( "lntbs" ) ) customNetwork = undefined;
    var decoded = bolt11.decode( invoice, customNetwork );
    var i; for ( i=0; i<decoded[ "tags" ].length; i++ ) {
        if ( decoded[ "tags" ][ i ][ "tagName" ] == "description" ) return decoded[ "tags" ][ i ][ "data" ].toString();
    }
}

var getInvoiceDeschash = invoice => {
    var customNetwork = { bech32: "tbs", pubKeyHash: 63, scriptHash: 123, validWitnessVersions: [ 0, 1 ] }
    if ( !invoice.startsWith( "lntbs" ) ) customNetwork = undefined;
    var decoded = bolt11.decode( invoice, customNetwork );
    var i; for ( i=0; i<decoded[ "tags" ].length; i++ ) {
        if ( decoded[ "tags" ][ i ][ "tagName" ] == "purpose_commit_hash" ) return decoded[ "tags" ][ i ][ "data" ].toString();
    }
}

var getInvoicePmthash = invoice => {
    var customNetwork = { bech32: "tbs", pubKeyHash: 63, scriptHash: 123, validWitnessVersions: [ 0, 1 ] }
    if ( !invoice.startsWith( "lntbs" ) ) customNetwork = undefined;
    var decoded = bolt11.decode( invoice, customNetwork );
    var i; for ( i=0; i<decoded[ "tags" ].length; i++ ) {
        if ( decoded[ "tags" ][ i ][ "tagName" ] == "payment_hash" ) return decoded[ "tags" ][ i ][ "data" ].toString();
    }
}

var getInvoiceAmount = invoice => {
    var customNetwork = { bech32: "tbs", pubKeyHash: 63, scriptHash: 123, validWitnessVersions: [ 0, 1 ] }
    if ( !invoice.startsWith( "lntbs" ) ) customNetwork = undefined;
    var decoded = bolt11.decode( invoice, customNetwork );
    var amount = decoded[ "satoshis" ].toString();
    return Number( amount );
}

var checkInvoiceTilPaidOrError = async ( invoice, app_pubkey ) => {
    var is_paid = await checkLNInvoice( {payment_request: invoice}, app_pubkey );
    if ( is_paid ) return;
    var pmthash = getInvoicePmthash( invoice );
    var expiry = global_state.nostr_state.nwc_info[ app_pubkey ].tx_history[ pmthash ][ "expires_at" ];
    var now = Math.floor( Date.now() / 1000 );
    if ( now >= expiry ) return;
    await super_nostr.waitSomeSeconds( 20 );
    checkInvoiceTilPaidOrError( invoice, app_pubkey );
}

var checkLNInvoice = async ( invoice_obj, app_pubkey ) => {
    if ( typeof invoice_obj !== "object" ) {
        //I normally pass in an invoice_data object which I got
        //from the mint. But when this is an invoice *I* am
        //paying, the mint doesn't have any info about this
        //invoice, so instead, I do this: I pass an actual
        //"invoice" to this function -- which detect that it is
        //not an object, and thus it is not the kind of thing
        //the mint knows about -- and I simply check if my
        //tx_history has a settled_at value. If so, it is
        //settled and I don't need to ask the mint.
        var pmthash = getInvoicePmthash( invoice_obj );
        return !!global_state.nostr_state.nwc_info[ app_pubkey ].tx_history[ pmthash ].settled_at;
    }
    var pmthash = getInvoicePmthash( invoice_obj[ "payment_request" ] );
    var settled_status = global_state.nostr_state.nwc_info[ app_pubkey ].tx_history[ pmthash ][ "settled_at" ];
    var invoice_data = await lookupInvoice( pmthash );
    var is_paid = invoice_data[ "settled" ];
    if ( is_paid ) global_state.nostr_state.nwc_info[ app_pubkey ].tx_history[ pmthash ][ "paid" ] = true;
    var old_state = global_state.nostr_state.nwc_info[ app_pubkey ].tx_history[ pmthash ][ "hodl_status" ];;
    var new_state = invoice_data[ "state" ];
    var status_changed = is_paid && !settled_status;
    if ( status_changed ) global_state.nostr_state.nwc_info[ app_pubkey ].tx_history[ pmthash ][ "settled_at" ] = Math.floor( Date.now() / 1000 );
    if ( status_changed ) global_state.nostr_state.nwc_info[ app_pubkey ].balance = global_state.nostr_state.nwc_info[ app_pubkey ].balance + global_state.nostr_state.nwc_info[ app_pubkey ].tx_history[ pmthash ][ "amount" ];
    var hodl_status_changed = old_state !== new_state;
    if ( hodl_status_changed ) global_state.nostr_state.nwc_info[ app_pubkey ].tx_history[ pmthash ][ "hodl_status" ] = new_state;
    if ( hodl_status_changed && new_state === "OPEN" ) global_state.nostr_state.nwc_info[ app_pubkey ].tx_history[ pmthash ][ "hodl_status" ] = "NO_PAYMENT_DETECTED";
    if ( hodl_status_changed && new_state === "ACCEPTED" ) global_state.nostr_state.nwc_info[ app_pubkey ].tx_history[ pmthash ][ "hodl_status" ] = "PAYMENT_DETECTED___YOU_MAY_NOW_SETTLE_OR_CANCEL";
    if ( hodl_status_changed && new_state === "CANCELED" ) global_state.nostr_state.nwc_info[ app_pubkey ].tx_history[ pmthash ][ "hodl_status" ] = "CANCELED";
    if ( hodl_status_changed && new_state === "SETTLED" ) global_state.nostr_state.nwc_info[ app_pubkey ].tx_history[ pmthash ][ "hodl_status" ] = "SETTLED";
    return is_paid;
}

var super_nostr = {
    sockets: {},
    hexToBytes: hex => Uint8Array.from( hex.match( /.{1,2}/g ).map( byte => parseInt( byte, 16 ) ) ),
    bytesToHex: bytes => bytes.reduce( ( str, byte ) => str + byte.toString( 16 ).padStart( 2, "0" ), "" ),
    hexToBase64: hex => btoa( hex.match( /\w{2}/g ).map( a => String.fromCharCode( parseInt( a, 16 ) ) ).join( "" ) ),
    base64ToHex: str => {
        var raw = atob( str );
        var result = '';
        var i; for ( i=0; i<raw.length; i++ ) {
            var hex = raw.charCodeAt( i ).toString( 16 );
            result += hex.length % 2 ? '0' + hex : hex;
        }
        return result.toLowerCase();
    },
    base64ToBytes: str => {
        var raw = atob( str );
        var result = [];
        var i; for ( i=0; i<raw.length; i++ ) result.push( raw.charCodeAt( i ) );
        return new Uint8Array( result );
    },
    getPrivkey: () => super_nostr.bytesToHex( nobleSecp256k1.utils.randomPrivateKey() ),
    getPubkey: privkey => nobleSecp256k1.getPublicKey( privkey, true ).substring( 2 ),
    sha256: async text_or_bytes => {if ( typeof text_or_bytes === "string" ) text_or_bytes = ( new TextEncoder().encode( text_or_bytes ) );return super_nostr.bytesToHex( await nobleSecp256k1.utils.sha256( text_or_bytes ) )},
    waitSomeSeconds: num => {
        var num = num.toString() + "000";
        num = Number( num );
        return new Promise( resolve => setTimeout( resolve, num ) );
    },
    getEvents: async ( relay_or_socket, ids, authors, kinds, until, since, limit, etags, ptags ) => {
        var socket_is_permanent = false;
        if ( typeof relay_or_socket !== "string" ) socket_is_permanent = true;
        if ( typeof relay_or_socket === "string" ) var socket = new WebSocket( relay_or_socket );
        else var socket = relay_or_socket;
        var events = [];
        var opened = false;
        if ( socket_is_permanent ) {
            var subId = super_nostr.bytesToHex( nobleSecp256k1.utils.randomPrivateKey() ).substring( 0, 16 );
            var filter  = {}
            if ( ids ) filter.ids = ids;
            if ( authors ) filter.authors = authors;
            if ( kinds ) filter.kinds = kinds;
            if ( until ) filter.until = until;
            if ( since ) filter.since = since;
            if ( limit ) filter.limit = limit;
            if ( etags ) filter[ "#e" ] = etags;
            if ( ptags ) filter[ "#p" ] = ptags;
            var subscription = [ "REQ", subId, filter ];
            socket.send( JSON.stringify( subscription ) );
            return;
        }
        socket.addEventListener( 'message', async function( message ) {
            var [ type, subId, event ] = JSON.parse( message.data );
            var { kind, content } = event || {}
            if ( !event || event === true ) return;
            events.push( event );
        });
        socket.addEventListener( 'open', async function( e ) {
            opened = true;
            var subId = super_nostr.bytesToHex( nobleSecp256k1.utils.randomPrivateKey() ).substring( 0, 16 );
            var filter  = {}
            if ( ids ) filter.ids = ids;
            if ( authors ) filter.authors = authors;
            if ( kinds ) filter.kinds = kinds;
            if ( until ) filter.until = until;
            if ( since ) filter.since = since;
            if ( limit ) filter.limit = limit;
            if ( etags ) filter[ "#e" ] = etags;
            if ( ptags ) filter[ "#p" ] = ptags;
            var subscription = [ "REQ", subId, filter ];
            socket.send( JSON.stringify( subscription ) );
        });
        var loop = async () => {
            if ( !opened ) {
                await super_nostr.waitSomeSeconds( 1 );
                return await loop();
            }
            var len = events.length;
            await super_nostr.waitSomeSeconds( 1 );
            if ( len !== events.length ) return await loop();
            socket.close();
            return events;
        }
        return await loop();
    },
    prepEvent: async ( privkey, msg, kind, tags ) => {
        var pubkey = super_nostr.getPubkey( privkey );
        if ( !tags ) tags = [];
        var event = {
            "content": msg,
            "created_at": Math.floor( Date.now() / 1000 ),
            "kind": kind,
            "tags": tags,
            "pubkey": pubkey,
        }
        var signedEvent = await super_nostr.getSignedEvent( event, privkey );
        return signedEvent;
    },
    sendEvent: ( event, relay_or_socket ) => {
        var socket_is_permanent = false;
        if ( typeof relay_or_socket !== "string" ) socket_is_permanent = true;
        if ( typeof relay_or_socket === "string" ) var socket = new WebSocket( relay_or_socket );
        else var socket = relay_or_socket;
        if ( !socket_is_permanent ) {
            socket.addEventListener( 'open', async () => {
                socket.send( JSON.stringify( [ "EVENT", event ] ) );
                setTimeout( () => {socket.close();}, 1000 );
            });
        } else {
            socket.send( JSON.stringify( [ "EVENT", event ] ) );
        }
        return event.id;
    },
    getSignedEvent: async ( event, privkey ) => {
        var eventData = JSON.stringify([
            0,
            event['pubkey'],
            event['created_at'],
            event['kind'],
            event['tags'],
            event['content'],
        ]);
        event.id = await super_nostr.sha256( eventData );
        event.sig = await nobleSecp256k1.schnorr.sign( event.id, privkey );
        return event;
    },
    //the "alt_encrypt" and "alt_decrypt" functions are
    //alternatives to the defaults; I think they are
    //better because they eliminate the dependency
    //on browserify-cipher, but they are asynchronous
    //and I already made so much stuff with this library
    //that assumes synchronicity, I don't want to change
    //it all
    alt_encrypt: async ( privkey, pubkey, text ) => {
        var msg = ( new TextEncoder() ).encode( text );
        var iv = crypto.getRandomValues( new Uint8Array( 16 ) );
        var key_raw = super_nostr.hexToBytes( nobleSecp256k1.getSharedSecret( privkey, '02' + pubkey, true ).substring( 2 ) );
        var key = await crypto.subtle.importKey(
            "raw",
            key_raw,
            "AES-CBC",
            false,
            [ "encrypt", "decrypt" ],
        );
        var emsg = await crypto.subtle.encrypt(
            {
                name: "AES-CBC",
                iv,
            },
            key,
            msg,
        )
        emsg = new Uint8Array( emsg );
        var arr = emsg;
        emsg = super_nostr.hexToBase64( super_nostr.bytesToHex( emsg ) ) + "?iv=" + btoa( String.fromCharCode.apply( null, iv ) );
        return emsg;
    },
    alt_decrypt: async ( privkey, pubkey, ciphertext ) => {
        var [ emsg, iv ] = ciphertext.split( "?iv=" );
        var key_raw = super_nostr.hexToBytes( nobleSecp256k1.getSharedSecret( privkey, '02' + pubkey, true ).substring( 2 ) );
        var key = await crypto.subtle.importKey(
            "raw",
            key_raw,
            "AES-CBC",
            false,
            [ "encrypt", "decrypt" ],
        );
        var decrypted = await crypto.subtle.decrypt(
            {
                name: "AES-CBC",
                iv: super_nostr.base64ToBytes( iv ),
            },
            key,
            super_nostr.base64ToBytes( emsg ),
        );
        var msg = ( new TextDecoder() ).decode( decrypted );
        return msg;
    },
    //var listenFunction = async socket => {
    //    var subId = super_nostr.bytesToHex( crypto.getRandomValues( new Uint8Array( 8 ) ) );
    //    var filter  = {}
    //    filter.kinds = [ 1 ];
    //    filter.limit = 1;
    //    filter.since = Math.floor( Date.now() / 1000 ) - 86400;
    //    var subscription = [ "REQ", subId, filter ];
    //    socket.send( JSON.stringify( subscription ) );
    //}
    //var handleFunction = async message => {
    //    var [ type, subId, event ] = JSON.parse( message.data );
    //    if ( !event || event === true ) return;
    //    console.log( event );
    //}
    newPermanentConnection: ( relay, listenFunction, handleFunction ) => {
        var socket_id = super_nostr.bytesToHex( nobleSecp256k1.utils.randomPrivateKey() ).substring( 0, 16 );
        super_nostr.sockets[ socket_id ] = {socket: null, connection_failure: false}
        super_nostr.connectionLoop( 0, relay, socket_id, listenFunction, handleFunction );
        return socket_id;
    },
    connectionLoop: async ( tries = 0, relay, socket_id, listenFunction, handleFunction ) => {
        var socketRetrieverFunction = socket_id => {
            return super_nostr.sockets[ socket_id ][ "socket" ];
        }
        var socketReplacerFunction = ( socket_id, socket ) => {
            super_nostr.sockets[ socket_id ][ "socket" ] = socket;
            super_nostr.sockets[ socket_id ][ "connection_failure" ] = false;
        }
        var socketFailureCheckerFunction = socket_id => {
            return super_nostr.sockets[ socket_id ][ "connection_failure" ];
        }
        var socketFailureSetterFunction = socket_id => {
            return super_nostr.sockets[ socket_id ][ "connection_failure" ] = true;
        }
        if ( socketFailureCheckerFunction( socket_id ) ) return alert( `your connection to nostr failed and could not be restarted, please refresh the page` );
        var socket = socketRetrieverFunction( socket_id );
        if ( !socket ) {
            var socket = new WebSocket( relay );
            socket.addEventListener( 'message', handleFunction );
            socket.addEventListener( 'open', ()=>{listenFunction( socket );} );
            socketReplacerFunction( socket_id, socket );
        }
        if ( socket.readyState === 1 ) {
            await super_nostr.waitSomeSeconds( 1 );
            return super_nostr.connectionLoop( 0, relay, socket_id, listenFunction, handleFunction );
        }
        // if there is no connection, check if we are still connecting
        // give it two chances to connect if so
        if ( socket.readyState === 0 && !tries ) {
            await super_nostr.waitSomeSeconds( 1 );
            return super_nostr.connectionLoop( 1, relay, socket_id, listenFunction, handleFunction );
        }
        if ( socket.readyState === 0 && tries ) {
            socketFailureSetterFunction( socket_id );
            return;
        }
        // otherwise, it is either closing or closed
        // ensure it is closed, then make a new connection
        socket.close();
        await super_nostr.waitSomeSeconds( 1 );
        socket = new WebSocket( relay );
        socket.addEventListener( 'message', handleFunction );
        socket.addEventListener( 'open', ()=>{listenFunction( socket );} );
        socketReplacerFunction( socket_id, socket );
        await super_nostr.connectionLoop( 0, relay, socket_id, listenFunction, handleFunction );
    }
}

var global_state = {
    relays: [ "wss://nostrue.com" ],
    privkey: super_nostr.getPrivkey(),
    pubkey: null,    
    nostr_state: {
        sockets: {},
        nwc_info: {},
    },
}
global_state.pubkey = super_nostr.getPubkey( global_state.privkey );

var getBlockheight = async () => {
    var data = await fetch( `https://mempool.space/api/blocks/tip/height` );
    return Number( await data.text() );
}

var getBlockhash = async blocknum => {
    var data = await fetch( `https://mempool.space/api/block-height/${blocknum}` );
    return data.text();
}

async function getLspPubkey() {
    return new Promise( resolve => {
        var macaroon = adminmac;
        var endpoint = lndendpoint + "/v1/getinfo";
        var options = {
            url: endpoint,
            // Work-around for self-signed certificates.
            rejectUnauthorized: false,
            json: true,
            headers: {
                'Grpc-Metadata-macaroon': macaroon,
            }
        }
        request.get( options, ( error, response, body ) => {
            resolve( body[ "identity_pubkey" ] );
        });        
    });
}

async function getLNInvoice( amount, desc ) {
    return new Promise( resolve => {
        var macaroon = adminmac;
        var endpoint = lndendpoint + "/v1/invoices";
        var requestBody = {
            memo: desc,
            value: String( amount ),
            private: true,
        };
        var options = {
            url: endpoint,
            // Work-around for self-signed certificates.
            rejectUnauthorized: false,
            json: true,
            headers: {
                'Grpc-Metadata-macaroon': macaroon,
            },
            form: JSON.stringify( requestBody ),
        }
        request.post( options, ( error, response, body ) => {
            resolve( body );
        });
    });
}

async function getHodlInvoice( amount, payment_hash, expiry = 40, desc, desc_hash ) {
    return new Promise( resolve => {
        var macaroon = adminmac;
        var endpoint = lndendpoint + "/v2/invoices/hodl";
        var requestBody = {
            hash: Buffer.from( payment_hash, "hex" ).toString( "base64" ),
            value: String( amount ),
            cltv_expiry: expiry.toString(),
            private: true,
        };
        if ( desc ) requestBody.memo = desc;
        if ( desc_hash ) requestBody.description_hash = Buffer.from( desc_hash, "hex" ).toString( "base64" );
        var options = {
            url: endpoint,
            // Work-around for self-signed certificates.
            rejectUnauthorized: false,
            json: true,
            headers: {
                'Grpc-Metadata-macaroon': macaroon,
            },
            form: JSON.stringify( requestBody ),
        }
        request.post( options, ( error, response, body ) => {
            resolve( body );
        });
    });
}

async function settleHodlInvoice( preimage ) {
    return new Promise( resolve => {
        var macaroon = adminmac;
        var endpoint = lndendpoint + `/v2/invoices/settle`;
        var requestBody = {
            preimage: Buffer.from( preimage, "hex" ).toString( "base64" )
        }
        var options = {
            url: endpoint,
            // Work-around for self-signed certificates.
            rejectUnauthorized: false,
            json: true,
            headers: {
                'Grpc-Metadata-macaroon': macaroon,
            },
            form: JSON.stringify( requestBody ),
        }
        request.post( options, ( error, response, body ) => {
            if ( body.toString().includes( "{" ) ) {
                resolve( "true" );
            } else {
                resolve( "false" );
            }
        });
    });
}

async function cancelHodlInvoice( payment_hash ) {
    return new Promise( resolve => {
        var macaroon = adminmac;
        var endpoint = lndendpoint + `/v2/invoices/cancel`;
        var requestBody = {
            payment_hash: Buffer.from( payment_hash, "hex" ).toString( "base64" ),
        }
        var options = {
            url: endpoint,
            // Work-around for self-signed certificates.
            rejectUnauthorized: false,
            json: true,
            headers: {
                'Grpc-Metadata-macaroon': macaroon,
            },
            form: JSON.stringify( requestBody ),
        }
        request.post( options, ( error, response, body ) => {
            if ( body.toString().includes( "{" ) ) {
                resolve( "true" );
            } else {
                resolve( "false" );
            }
        });
    });
}

async function lookupInvoice( pmthash ) {
    return new Promise( resolve => {
        var macaroon = adminmac;
        var endpoint = lndendpoint + `/v1/invoice/${pmthash}`;
        var options = {
            url: endpoint,
            // Work-around for self-signed certificates.
            rejectUnauthorized: false,
            json: true,
            headers: {
                'Grpc-Metadata-macaroon': macaroon,
            }
        }
        request.get( options, ( error, response, body ) => {
            resolve( body );
        });        
    });
}

var lnSend = async ( invoice, amt_for_amountless_invoice, app_pubkey ) => {
    return new Promise( resolve => {
        var macaroon = adminmac;
        var endpoint = lndendpoint + `/v2/router/send`;
        var requestBody = {
            payment_request: invoice,
            timeout_seconds: 10,
            no_inflight_updates: true,
            // final_cltv_delta: <integer>, // <int32> 
            // cltv_limit: <integer>, // <int32> 
        };
        var options = {
            url: endpoint,
            // Work-around for self-signed certificates.
            rejectUnauthorized: false,
            json: true,
            headers: {
                'Grpc-Metadata-macaroon': macaroon,
            },
            form: JSON.stringify( requestBody ),
        }
        request.post( options, async ( error, response, body ) => {
            if ( body.result.status && body.result.status === "SUCCEEDED" ) {
                var preimage = body.result.payment_preimage;
                var fee = body.result.fee;
                var pmthash = getInvoicePmthash( invoice );
                var state = global_state.nostr_state.nwc_info[ app_pubkey ];
                state.tx_history[ pmthash ][ "preimage" ] = preimage;
                state.tx_history[ pmthash ][ "settled_at" ] = Math.floor( Date.now() / 1000 );
                state.tx_history[ pmthash ][ "paid" ] = true;
                state.tx_history[ pmthash ][ "fees_paid" ] = fee;
                state.balance = state.balance - state.tx_history[ pmthash ][ "amount" ] - fee;
                resolve( "payment succeeded" );
            }
            if ( body.result.failure_reason ) resolve( body.result.failure_reason );
            resolve( JSON.stringify( body ) );
        });
    });
} 

var getEvents = async ( relay, ids, authors, kinds, until, since, limit, etags, ptags ) => {
    var socket = new WebSocket( relay );
    var events = [];
    socket.on( 'message',  message => {
        var [ type, subId, event ] = JSON.parse( hexToText( message.toString( "hex" ) ) );
        var { kind, content } = event || {}
        if ( !event || event === true ) return;
        events.push( event );
    });
    socket.on( 'open', async () => {
        var subId = bytesToHex( nobleSecp256k1.utils.randomPrivateKey() ).substring( 0, 16 );
        var filter = {}
        if ( ids ) filter.ids = ids;
        if ( authors ) filter.authors = authors;
        if ( kinds ) filter.kinds = kinds;
        if ( until ) filter.until = until;
        if ( since ) filter.since = since;
        if ( limit ) filter.limit = limit;
        if ( etags ) filter[ "#e" ] = etags;
        if ( ptags ) filter[ "#p" ] = ptags;
        var subscription = [ "REQ", subId, filter ];
        socket.send( JSON.stringify( subscription ) );
    });
    var loop = async () => {
        var len = events.length;
        await waitSomeSeconds( 1 );
        if ( len !== events.length ) return await loop();
        socket.close();
        return events;
    }
    return await loop();
}

var getRecipientFromNostrEvent = event => {
    var i; for ( i=0; i<event.tags.length; i++ ) {
        if ( event.tags[ i ] && event.tags[ i ][ 0 ] && event.tags[ i ][ 1 ] && event.tags[ i ][ 0 ] == "p" ) return event.tags[ i ][ 1 ];
    }
}

var convertPubkeyAndRelaysToNprofile = ( prefix, pubkey, relays ) => {
    var relays_str = "";
    relays.forEach( relay => {
        var relay_str = textToHex( relay );
        var len = ( relay_str.length / 2 ).toString( 16 );
        if ( len.length % 2 ) len = "0" + len;
        relays_str = relays_str + "01" + len + relay_str;
    });
    var hex = relays_str + "0020" + pubkey;
    var bytes = super_nostr.hexToBytes( hex );
    var nevent = bech32.bech32.encode( prefix, bech32.bech32.toWords( bytes ), 100_000 );
    return nevent;
}
var listenFunction = async socket => {
   var subId = super_nostr.bytesToHex( crypto.getRandomValues( new Uint8Array( 8 ) ) );
   var filter  = {}
   filter.kinds = [ 23194 ];
   filter.since = Math.floor( Date.now() / 1000 );
   filter[ "#p" ] = [ global_state.pubkey ];
   var subscription = [ "REQ", subId, filter ];
   socket.send( JSON.stringify( subscription ) );
}

var handleFunction = async message => {
    var [ type, subId, event ] = JSON.parse( message.data );
    if ( !event || event === true ) return;
    var { kind, content } = event || {}
    var app_pubkey = getRecipientFromNostrEvent( event );
    if ( app_pubkey !== global_state.pubkey ) return;
    var state = global_state.nostr_state.nwc_info[ app_pubkey ];
    if ( event.pubkey !== state[ "user_pubkey" ] ) return;
    //validate sig
    var serial_event = JSON.stringify([
        0,
        event['pubkey'],
        event['created_at'],
        event['kind'],
        event['tags'],
        event['content']
    ]);
    var id_bytes = await nobleSecp256k1.utils.sha256( super_nostr.hexToBytes( textToHex( serial_event ) ) );
    var id = super_nostr.bytesToHex( id_bytes );
    var sig = event.sig;
    var pubkey = event.pubkey;
    var sig_is_valid = await nobleSecp256k1.schnorr.verify( sig, id, pubkey );
    if ( !sig_is_valid ) return;
    var command = await super_nostr.alt_decrypt( state[ "app_privkey" ], event.pubkey, content );
    try {
        command = JSON.parse( command );
        console.log( command );
        if ( !state.permissions.includes( command.method ) ) {
            var reply = JSON.stringify({
                result_type: command.method,
                error: {
                    code: "RESTRICTED",
                    message: "This public key is not allowed to do this operation.",
                },
                result: {}
            });
            var emsg = await super_nostr.alt_encrypt( state[ "app_privkey" ], event.pubkey, reply );
            var event = await super_nostr.prepEvent( state[ "app_privkey" ], emsg, 23195, [ [ "p", event.pubkey ], [ "e", event.id ] ] );
            return super_nostr.sendEvent( event, global_state.relays[ 0 ] );
        }
        if ( command.method === "get_info" ) {
            var blockheight = await getBlockheight();
            var blockhash = await getBlockhash( blockheight );
            var reply = JSON.stringify({
                result_type: command.method,
                result: {
                    alias: "",
                    color: "",
                    pubkey: "",
                    network: "mainnet",
                    block_height: blockheight,
                    block_hash: blockhash,
                    methods: state.permissions,
                },
            });
            var emsg = await super_nostr.alt_encrypt( state[ "app_privkey" ], event.pubkey, reply );
            var event = await super_nostr.prepEvent( state[ "app_privkey" ], emsg, 23195, [ [ "p", event.pubkey ], [ "e", event.id ] ] );
            return super_nostr.sendEvent( event, global_state.relays[ 0 ] );
        }
        if ( command.method === "get_balance" ) {
            var reply = JSON.stringify({
                result_type: command.method,
                result: {
                    balance: global_state.nostr_state.nwc_info[ app_pubkey ].balance,
                },
            });
            var emsg = await super_nostr.alt_encrypt( state[ "app_privkey" ], event.pubkey, reply );
            var event = await super_nostr.prepEvent( state[ "app_privkey" ], emsg, 23195, [ [ "p", event.pubkey ], [ "e", event.id ] ] );
            return super_nostr.sendEvent( event, global_state.relays[ 0 ] );
        }
        if ( command.method === "make_invoice" ) {
            if ( !String( command.params.amount ).endsWith( "000" ) ) {
                var reply = JSON.stringify({
                    result_type: command.method,
                    error: {
                        code: "OTHER",
                        message: "amount must end in 000 (remember, we require millisats! But they must always be zero!)",
                    },
                    result: {}
                });
                var emsg = await super_nostr.alt_encrypt( state[ "app_privkey" ], event.pubkey, reply );
                var event = await super_nostr.prepEvent( state[ "app_privkey" ], emsg, 23195, [ [ "p", event.pubkey ], [ "e", event.id ] ] );
                return super_nostr.sendEvent( event, global_state.relays[ 0 ] );
            }
            var desc = "";
            if ( command.params.description ) desc = command.params.description;
            var invoice_data = await getLNInvoice( Math.floor( command.params.amount / 1000 ), desc );
            var invoice = invoice_data.payment_request;
            var customNetwork = { bech32: "tbs", pubKeyHash: 63, scriptHash: 123, validWitnessVersions: [ 0, 1 ] }
            if ( !invoice.startsWith( "lntbs" ) ) customNetwork = undefined;
            var reply = JSON.stringify({
                result_type: command.method,
                result: {
                    type: "incoming",
                    invoice,
                    bolt11: invoice,
                    description: getInvoiceDescription( invoice ) || "",
                    description_hash: getInvoiceDeschash( invoice ) || "",
                    preimage: "",
                    payment_hash: getInvoicePmthash( invoice ),
                    amount: getInvoiceAmount( invoice ),
                    fees_paid: 0,
                    created_at: bolt11.decode( invoice, customNetwork ).timestamp,
                    expires_at: bolt11.decode( invoice, customNetwork ).timeExpireDate,
                    settled_at: null,
                    hodl_status: "NO_PAYMENT_DETECTED",
                },
            });
            state.tx_history[ getInvoicePmthash( invoice ) ] = {
                invoice_data,
                pmthash: getInvoicePmthash( invoice ),
                amount: getInvoiceAmount( invoice ) * 1000,
                invoice,
                bolt11: invoice,
                type: "incoming",
                description: getInvoiceDescription( invoice ) || "",
                description_hash: getInvoiceDeschash( invoice ) || "",
                preimage: "",
                payment_hash: getInvoicePmthash( invoice ),
                fees_paid: 0,
                created_at: bolt11.decode( invoice, customNetwork ).timestamp,
                expires_at: bolt11.decode( invoice, customNetwork ).timeExpireDate,
                settled_at: null,
                paid: false,
                hodl_status: "NO_PAYMENT_DETECTED",
            }
            checkInvoiceTilPaidOrError( invoice, app_pubkey );
            var emsg = await super_nostr.alt_encrypt( state[ "app_privkey" ], event.pubkey, reply );
            var event = await super_nostr.prepEvent( state[ "app_privkey" ], emsg, 23195, [ [ "p", event.pubkey ], [ "e", event.id ] ] );
            return super_nostr.sendEvent( event, global_state.relays[ 0 ] );
        }
        if ( command.method === "lookup_invoice" ) {
            var invoice = null;
            if ( "bolt11" in command.params ) invoice = command.params.bolt11;
            if ( "invoice" in command.params && !invoice ) invoice = command.params.invoice;
            if ( invoice ) var pmthash = getInvoicePmthash( invoice );
            if ( "payment_hash" in command.params && !pmthash ) {
                var pmthash = command.params.payment_hash;
            }
            if ( !pmthash || !( pmthash in state.tx_history ) ) {
                var reply = JSON.stringify({
                    result_type: command.method,
                    error: {
                        code: "INTERNAL",
                        message: "invoice not found",
                    },
                    result: {}
                });
                var emsg = await super_nostr.alt_encrypt( state[ "app_privkey" ], event.pubkey, reply );
                var event = await super_nostr.prepEvent( state[ "app_privkey" ], emsg, 23195, [ [ "p", event.pubkey ], [ "e", event.id ] ] );
                return super_nostr.sendEvent( event, global_state.relays[ 0 ] );
            }
            if ( !invoice ) invoice = state.tx_history[ pmthash ].invoice;
            var invoice_data = state.tx_history[ pmthash ][ "invoice_data" ];
            if ( !invoice_data ) invoice_data = invoice;
            var invoice_is_settled = await checkLNInvoice( invoice_data, app_pubkey );
            var preimage_to_return = state.tx_history[ pmthash ][ "preimage" ];
            if ( state.tx_history[ pmthash ][ "settled_at" ] && !preimage_to_return ) preimage_to_return = "0".repeat( 64 );
            var reply = {
                result_type: "lookup_invoice",
                result: {
                    type: state.tx_history[ pmthash ][ "type" ],
                    invoice: invoice,
                    bolt11: invoice,
                    description: state.tx_history[ pmthash ][ "description" ],
                    description_hash: state.tx_history[ pmthash ][ "description_hash" ],
                    preimage: preimage_to_return,
                    payment_hash: pmthash,
                    amount: state.tx_history[ pmthash ][ "amount" ],
                    fees_paid: state.tx_history[ pmthash ][ "fees_paid" ],
                    created_at: state.tx_history[ pmthash ][ "created_at" ],
                    expires_at: state.tx_history[ pmthash ][ "expires_at" ],
                    settled_at: state.tx_history[ pmthash ][ "settled_at" ],
                    hodl_status: state.tx_history[ pmthash ][ "hodl_status" ],
                }
            }
            if ( "err_msg" in state.tx_history[ pmthash ] && state.tx_history[ pmthash ][ "err_msg" ] ) {
                reply.error = {
                    code: "OTHER",
                    message: state.tx_history[ pmthash ][ "err_msg" ],
                }
                reply.result = {}
            }
            reply = JSON.stringify( reply );
            var emsg = await super_nostr.alt_encrypt( state[ "app_privkey" ], event.pubkey, reply );
            var event = await super_nostr.prepEvent( state[ "app_privkey" ], emsg, 23195, [ [ "p", event.pubkey ], [ "e", event.id ] ] );
            return super_nostr.sendEvent( event, global_state.relays[ 0 ] );
        }
        if ( command.method === "list_transactions" ) {
            var txids = Object.keys( global_state.nostr_state.nwc_info[ app_pubkey ].tx_history );
            var txs = [];
            var include_unpaid = false;
            var include_incoming = true;
            var include_outgoing = true;
            if ( "unpaid" in command.params && command.params[ "unpaid" ] ) include_unpaid = true;
            if ( "type" in command.params && command.params[ "type" ] === "incoming" ) include_outgoing = false;
            if ( "type" in command.params && command.params[ "type" ] === "outgoing" ) include_incoming = false;
            txids.forEach( item => {
                var tx = global_state.nostr_state.nwc_info[ app_pubkey ].tx_history[ item ];
                if ( !include_unpaid && !tx[ "paid" ] ) return;
                if ( !include_incoming && tx[ "type" ] === "incoming" ) return;
                if ( !include_outgoing && tx[ "type" ] === "outgoing" ) return;
                txs.push( tx );
            });
            txs = JSON.parse( JSON.stringify( txs ) );
            txs.forEach( item => delete item[ "invoice_data" ] );
            txs.sort( ( a, b ) => b[ "created_at" ] - a[ "created_at" ] );
            if ( "from" in command.params ) {
                var new_txs = [];
                txs.forEach( item => {
                    if ( item.created_at < command.params[ "from" ] ) return;
                    new_txs.push( item );
                });
                txs = JSON.parse( JSON.stringify( new_txs ) );
            }
            if ( "until" in command.params ) {
                var new_txs = [];
                txs.forEach( item => {
                    if ( item.created_at > command.params[ "until" ] ) return;
                    new_txs.push( item );
                });
                txs = JSON.parse( JSON.stringify( new_txs ) );
            }
            if ( "offset" in command.params ) {
                var new_txs = [];
                txs.every( ( item, index ) => {
                    if ( index < command.params[ "offset" ] ) return true;
                    new_txs.push( item );
                });
                txs = JSON.parse( JSON.stringify( new_txs ) );
                return true;
            }
            if ( "limit" in command.params ) {
                var new_txs = [];
                txs.every( item => {
                    if ( new_txs.length >= command.params[ "limit" ] ) return;
                    new_txs.push( item );
                    return true;
                });
                txs = JSON.parse( JSON.stringify( new_txs ) );
            }
            var reply = JSON.stringify({
                result_type: command.method,
                result: {
                    transactions: txs,
                },
            });
            var emsg = await super_nostr.alt_encrypt( state[ "app_privkey" ], event.pubkey, reply );
            var event = await super_nostr.prepEvent( state[ "app_privkey" ], emsg, 23195, [ [ "p", event.pubkey ], [ "e", event.id ] ] );
            return super_nostr.sendEvent( event, global_state.relays[ 0 ] );
        }
        if ( command.method === "pay_invoice" ) {
            var invoice = null;
            if ( "bolt11" in command.params ) invoice = command.params.bolt11;
            if ( "invoice" in command.params && !invoice ) invoice = command.params.invoice;
            if ( invoice ) var pmthash = getInvoicePmthash( invoice );
            else return;
            var customNetwork = { bech32: "tbs", pubKeyHash: 63, scriptHash: 123, validWitnessVersions: [ 0, 1 ] }
            if ( !invoice.startsWith( "lntbs" ) ) customNetwork = undefined;
            var invoice_amt = bolt11.decode( invoice, customNetwork ).satoshis;

            //put the tx info in tx_history

            state.tx_history[ pmthash ] = {
                type: "outgoing",
                invoice: invoice,
                bolt11: invoice,
                description: getInvoiceDescription( invoice ),
                description_hash: getInvoiceDeschash( invoice ),
                preimage: "",
                payment_hash: pmthash,
                amount: Number( bolt11.decode( invoice, customNetwork ).millisatoshis ),
                fees_paid: 0,
                created_at: bolt11.decode( invoice, customNetwork ).timestamp,
                expires_at: bolt11.decode( invoice, customNetwork ).timeExpireDate,
                settled_at: null,
                paid: false,
                hodl_status: null,
            }

            if ( !invoice_amt ) {
                var err_msg = `amountless invoices are not yet supported by this backend`;
                global_state.nostr_state.nwc_info[ app_pubkey ].tx_history[ pmthash ][ "err_msg" ] = err_msg;
                var reply = JSON.stringify({
                    result_type: command.method,
                    error: {
                        code: "NOT_IMPLEMENTED",
                        message: `amountless invoices are not yet supported by this backend`,
                    },
                    result: {}
                });
                var emsg = await super_nostr.alt_encrypt( state[ "app_privkey" ], event.pubkey, reply );
                var event = await super_nostr.prepEvent( state[ "app_privkey" ], emsg, 23195, [ [ "p", event.pubkey ], [ "e", event.id ] ] );
                return super_nostr.sendEvent( event, global_state.relays[ 0 ] );
            }
            var balance = state.balance;
            if ( Math.floor( .99 * balance ) - ( invoice_amt * 1000 ) < 0 ) {
                var err_msg = `you must leave 1% in reserve to pay routing fees so the max amount you can pay is ${Math.floor( ( .99 * balance ) / 1000 )} sats and this invoice is for ${invoice_amt} sats`;
                global_state.nostr_state.nwc_info[ app_pubkey ].tx_history[ pmthash ][ "err_msg" ] = err_msg;
                var reply = JSON.stringify({
                    result_type: command.method,
                    error: {
                        code: "INSUFFICIENT_BALANCE",
                        message: `you must leave 1% in reserve to pay routing fees so the max amount you can pay is ${Math.floor( ( .99 * balance ) / 1000 )} sats and this invoice is for ${invoice_amt} sats`,
                    },
                    result: {}
                });
                var emsg = await super_nostr.alt_encrypt( state[ "app_privkey" ], event.pubkey, reply );
                var event = await super_nostr.prepEvent( state[ "app_privkey" ], emsg, 23195, [ [ "p", event.pubkey ], [ "e", event.id ] ] );
                return super_nostr.sendEvent( event, global_state.relays[ 0 ] );
            }

            var response_from_mint = await lnSend( invoice, null, app_pubkey );
            //response is one of two things:
            //1. an error message
            //2. "payment succeeded"

            if ( !response_from_mint.startsWith( "payment succeeded" ) ) {
                var err_msg = response_from_mint;
                global_state.nostr_state.nwc_info[ app_pubkey ].tx_history[ pmthash ][ "err_msg" ] = err_msg;
                var reply = JSON.stringify({
                    result_type: command.method,
                    error: {
                        code: "OTHER",
                        message: response_from_mint,
                    },
                    result: {}
                });
                var emsg = await super_nostr.alt_encrypt( state[ "app_privkey" ], event.pubkey, reply );
                var event = await super_nostr.prepEvent( state[ "app_privkey" ], emsg, 23195, [ [ "p", event.pubkey ], [ "e", event.id ] ] );
                return super_nostr.sendEvent( event, global_state.relays[ 0 ] );
            }

            var preimage_to_return = state.tx_history[ pmthash ][ "preimage" ];
            var reply = JSON.stringify({
                result_type: "pay_invoice",
                result: {
                    preimage: preimage_to_return,
                },
            });
            var emsg = await super_nostr.alt_encrypt( state[ "app_privkey" ], event.pubkey, reply );
            var event = await super_nostr.prepEvent( state[ "app_privkey" ], emsg, 23195, [ [ "p", event.pubkey ], [ "e", event.id ] ] );
            return super_nostr.sendEvent( event, global_state.relays[ 0 ] );
        }
        if ( command.method === "make_hodl_invoice" ) {
            if ( !String( command.params.amount ).endsWith( "000" ) ) {
                var reply = JSON.stringify({
                    result_type: command.method,
                    error: {
                        code: "OTHER",
                        message: "amount must end in 000 (remember, we require millisats! But they must always be zero!)",
                    },
                    result: {}
                });
                var emsg = await super_nostr.alt_encrypt( state[ "app_privkey" ], event.pubkey, reply );
                var event = await super_nostr.prepEvent( state[ "app_privkey" ], emsg, 23195, [ [ "p", event.pubkey ], [ "e", event.id ] ] );
                return super_nostr.sendEvent( event, global_state.relays[ 0 ] );
            }
            if ( !command.params.payment_hash ) {
                var reply = JSON.stringify({
                    result_type: command.method,
                    error: {
                        code: "OTHER",
                        message: "hodl invoices require specifying a payment hash!",
                    },
                    result: {}
                });
                var emsg = await super_nostr.alt_encrypt( state[ "app_privkey" ], event.pubkey, reply );
                var event = await super_nostr.prepEvent( state[ "app_privkey" ], emsg, 23195, [ [ "p", event.pubkey ], [ "e", event.id ] ] );
                return super_nostr.sendEvent( event, global_state.relays[ 0 ] );
            }
            if ( command.params.expiry && isNaN( command.params.expiry ) ) {
                var reply = JSON.stringify({
                    result_type: command.method,
                    error: {
                        code: "OTHER",
                        message: "expiry must be a number!",
                    },
                    result: {}
                });
                var emsg = await super_nostr.alt_encrypt( state[ "app_privkey" ], event.pubkey, reply );
                var event = await super_nostr.prepEvent( state[ "app_privkey" ], emsg, 23195, [ [ "p", event.pubkey ], [ "e", event.id ] ] );
                return super_nostr.sendEvent( event, global_state.relays[ 0 ] );
            }
            var payment_hash = "";
            var expiry = 40;
            var desc = "";
            var desc_hash = "";
            payment_hash = command.params.payment_hash;
            if ( command.params.expiry ) expiry = Number( command.params.expiry );
            if ( command.params.description ) desc = command.params.description;
            if ( command.params.desc_hash ) desc_hash = command.params.desc_hash;
            var invoice_data = await getHodlInvoice( Math.floor( command.params.amount / 1000 ), payment_hash, expiry, desc, desc_hash );
            var invoice = invoice_data.payment_request;
            var customNetwork = { bech32: "tbs", pubKeyHash: 63, scriptHash: 123, validWitnessVersions: [ 0, 1 ] }
            if ( !invoice.startsWith( "lntbs" ) ) customNetwork = undefined;
            var reply = JSON.stringify({
                result_type: command.method,
                result: {
                    type: "incoming",
                    invoice,
                    bolt11: invoice,
                    description: getInvoiceDescription( invoice ) || "",
                    description_hash: getInvoiceDeschash( invoice ) || "",
                    preimage: "",
                    payment_hash: getInvoicePmthash( invoice ),
                    amount: getInvoiceAmount( invoice ),
                    fees_paid: 0,
                    created_at: bolt11.decode( invoice, customNetwork ).timestamp,
                    expires_at: bolt11.decode( invoice, customNetwork ).timeExpireDate,
                    settled_at: null,
                    hodl_status: "NO_PAYMENT_DETECTED",
                },
            });
            state.tx_history[ getInvoicePmthash( invoice ) ] = {
                invoice_data,
                pmthash: getInvoicePmthash( invoice ),
                amount: getInvoiceAmount( invoice ) * 1000,
                invoice,
                bolt11: invoice,
                type: "incoming",
                description: getInvoiceDescription( invoice ) || "",
                description_hash: getInvoiceDeschash( invoice ) || "",
                preimage: "",
                payment_hash: getInvoicePmthash( invoice ),
                fees_paid: 0,
                created_at: bolt11.decode( invoice, customNetwork ).timestamp,
                expires_at: bolt11.decode( invoice, customNetwork ).timeExpireDate,
                settled_at: null,
                paid: false,
                hodl_status: "NO_PAYMENT_DETECTED",
            }
            checkInvoiceTilPaidOrError( invoice, app_pubkey );
            var emsg = await super_nostr.alt_encrypt( state[ "app_privkey" ], event.pubkey, reply );
            var event = await super_nostr.prepEvent( state[ "app_privkey" ], emsg, 23195, [ [ "p", event.pubkey ], [ "e", event.id ] ] );
            return super_nostr.sendEvent( event, global_state.relays[ 0 ] );
        }
        if ( command.method === "settle_hodl_invoice" ) {
            if ( !command.params.preimage ) {
                var reply = JSON.stringify({
                    result_type: command.method,
                    error: {
                        code: "OTHER",
                        message: "you forgot to include the preimage to the hodl invoice you want to settle!",
                    },
                    result: {}
                });
                var emsg = await super_nostr.alt_encrypt( state[ "app_privkey" ], event.pubkey, reply );
                var event = await super_nostr.prepEvent( state[ "app_privkey" ], emsg, 23195, [ [ "p", event.pubkey ], [ "e", event.id ] ] );
                return super_nostr.sendEvent( event, global_state.relays[ 0 ] );
            }
            var settled = await settleHodlInvoice( command.params.preimage );
            var preimage = command.params.preimage;
            var pmthash = await super_nostr.sha256( super_nostr.hexToBytes( preimage ) );
            var state = global_state.nostr_state.nwc_info[ app_pubkey ];
            state.tx_history[ pmthash ][ "preimage" ] = preimage;
            state.tx_history[ pmthash ][ "settled_at" ] = Math.floor( Date.now() / 1000 );
            state.tx_history[ pmthash ][ "paid" ] = true;
            var reply = JSON.stringify({
                result_type: command.method,
                result: {
                    type: state.tx_history[ pmthash ][ "type" ],
                    invoice: state.tx_history[ pmthash ][ "invoice" ],
                    bolt11: state.tx_history[ pmthash ][ "bolt11" ],
                    description: state.tx_history[ pmthash ][ "description" ],
                    description_hash: state.tx_history[ pmthash ][ "description_hash" ],
                    preimage: preimage,
                    payment_hash: pmthash,
                    amount: state.tx_history[ pmthash ][ "amount" ],
                    fees_paid: state.tx_history[ pmthash ][ "fees_paid" ],
                    created_at: state.tx_history[ pmthash ][ "created_at" ],
                    expires_at: state.tx_history[ pmthash ][ "expires_at" ],
                    settled_at: state.tx_history[ pmthash ][ "settled_at" ],
                    hodl_status: state.tx_history[ pmthash ][ "hodl_status" ],
                }
            });
            var emsg = await super_nostr.alt_encrypt( state[ "app_privkey" ], event.pubkey, reply );
            var event = await super_nostr.prepEvent( state[ "app_privkey" ], emsg, 23195, [ [ "p", event.pubkey ], [ "e", event.id ] ] );
            return super_nostr.sendEvent( event, global_state.relays[ 0 ] );
        }
        if ( command.method === "cancel_hodl_invoice" ) {
            if ( !command.params.payment_hash ) {
                var reply = JSON.stringify({
                    result_type: command.method,
                    error: {
                        code: "OTHER",
                        message: "you forgot to include the payment hash of the hodl invoice you want to cancel!",
                    },
                    result: {}
                });
                var emsg = await super_nostr.alt_encrypt( state[ "app_privkey" ], event.pubkey, reply );
                var event = await super_nostr.prepEvent( state[ "app_privkey" ], emsg, 23195, [ [ "p", event.pubkey ], [ "e", event.id ] ] );
                return super_nostr.sendEvent( event, global_state.relays[ 0 ] );
            }
            cancelHodlInvoice( command.params.payment_hash );
            var pmthash = command.params.payment_hash;
            var state = global_state.nostr_state.nwc_info[ app_pubkey ];
            var reply = JSON.stringify({
                result_type: command.method,
                result: state.tx_history[ pmthash ],
            });
            var emsg = await super_nostr.alt_encrypt( state[ "app_privkey" ], event.pubkey, reply );
            var event = await super_nostr.prepEvent( state[ "app_privkey" ], emsg, 23195, [ [ "p", event.pubkey ], [ "e", event.id ] ] );
            return super_nostr.sendEvent( event, global_state.relays[ 0 ] );
        }
    } catch ( e ) {
        try {
            var reply = JSON.stringify({
                result_type: command.method,
                error: {
                    code: "OTHER",
                    message: `unknown error`,
                },
                result: {}
            });
            var emsg = await super_nostr.alt_encrypt( state[ "app_privkey" ], event.pubkey, reply );
            var event = await super_nostr.prepEvent( state[ "app_privkey" ], emsg, 23195, [ [ "p", event.pubkey ], [ "e", event.id ] ] );
            return super_nostr.sendEvent( event, global_state.relays[ 0 ] );
        } catch( e2 ) {}
    }
}

(async()=>{
    var user_secret = super_nostr.bytesToHex( nobleSecp256k1.utils.randomPrivateKey() );
    var user_pubkey = nobleSecp256k1.getPublicKey( user_secret, true ).substring( 2 );
    var nwc_string = `nostr+walletconnect://${global_state.pubkey}?relay=${global_state.relays[ 0 ]}&secret=${user_secret}`;
    var permissions = [ "pay_invoice", "get_balance", "make_invoice", "lookup_invoice", "list_transactions", "get_info", "make_hodl_invoice", "settle_hodl_invoice", "cancel_hodl_invoice" ];
    global_state.nostr_state.nwc_info[ global_state.pubkey ] = {
        permissions,
        nwc_string,
        app_privkey: global_state.privkey,
        app_pubkey: global_state.pubkey,
        user_secret,
        user_pubkey,
        relay: global_state.relays[ 0 ],
        balance: 0,
        tx_history: {},
    }
    var connection = await super_nostr.newPermanentConnection( global_state.relays[ 0 ], listenFunction, handleFunction );
    global_state.nostr_state.sockets[ global_state.pubkey ] = super_nostr.sockets[ connection ];
    console.log( nwc_string );
})();
