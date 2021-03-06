/* @see ./routes.coffee for routing*/
var _ = require('lodash');
var shared = require('habitrpg-shared');
var nconf = require('nconf');
var utils = require('./../../utils');
var moment = require('moment');
var isProduction = nconf.get("NODE_ENV") === "production";
var stripe = require('./stripe');
var paypal = require('./paypal');
var members = require('../members')
var async = require('async');
var iap = require('./iap');
var mongoose= require('mongoose');
var cc = require('coupon-code');

function revealMysteryItems(user) {
  _.each(shared.content.gear.flat, function(item) {
    if (
      item.klass === 'mystery' &&
        moment().isAfter(shared.content.mystery[item.mystery].start) &&
        moment().isBefore(shared.content.mystery[item.mystery].end) &&
        !user.items.gear.owned[item.key] &&
        !~user.purchased.plan.mysteryItems.indexOf(item.key)
      ) {
      user.purchased.plan.mysteryItems.push(item.key);
    }
  });
}

exports.createSubscription = function(data, cb) {
  var recipient = data.gift ? data.gift.member : data.user;
  //if (!recipient.purchased.plan) recipient.purchased.plan = {}; // FIXME double-check, this should never be the case
  var p = recipient.purchased.plan;
  var block = shared.content.subscriptionBlocks[data.gift ? data.gift.subscription.key : data.sub.key];
  var months = +block.months;

  if (data.gift) {
    if (p.customerId && !p.dateTerminated) { // User has active plan
      p.extraMonths += months;
    } else {
      p.dateTerminated = moment(p.dateTerminated).add({months: months}).toDate();
    }
    if (!p.customerId) p.customerId = 'Gift'; // don't override existing customer, but all sub need a customerId
  } else {
    _(p).merge({ // override with these values
      planId: block.key,
      customerId: data.customerId,
      dateUpdated: new Date(),
      gemsBought: 0,
      paymentMethod: data.paymentMethod,
      extraMonths: +p.extraMonths
        + +(p.dateTerminated ? moment(p.dateTerminated).diff(new Date(),'months',true) : 0),
      dateTerminated: null
    }).defaults({ // allow non-override if a plan was previously used
      dateCreated: new Date(),
      mysteryItems: []
    });
  }

  // Block sub perks
  var perks = Math.floor(months/3);
  if (perks) {
    p.consecutive.offset += months;
    p.consecutive.gemCapExtra += perks*5;
    if (p.consecutive.gemCapExtra > 25) p.consecutive.gemCapExtra = 25;
    p.consecutive.trinkets += perks;
  }
  revealMysteryItems(recipient);
  if(isProduction) {
    if (!data.gift) utils.txnEmail(data.user, 'subscription-begins');
    utils.ga.event('subscribe', data.paymentMethod).send();
    utils.ga.transaction(data.user._id, block.price).item(block.price, 1, data.paymentMethod.toLowerCase() + '-subscription', data.paymentMethod).send();
  }
  data.user.purchased.txnCount++;
  if (data.gift) members.sendMessage(data.user, data.gift.member, data.gift);
  async.parallel([
    function(cb2){data.user.save(cb2)},
    function(cb2){data.gift ? data.gift.member.save(cb2) : cb2(null);}
  ], cb);
}

/**
 * Sets their subscription to be cancelled later
 */
exports.cancelSubscription = function(data, cb) {
  var p = data.user.purchased.plan,
    now = moment(),
    remaining = data.nextBill ? moment(data.nextBill).diff(new Date, 'days') : 30;

  p.dateTerminated =
    moment( now.format('MM') + '/' + moment(p.dateUpdated).format('DD') + '/' + now.format('YYYY') )
    .add({days: remaining}) // end their subscription 1mo from their last payment
    .add({months: Math.ceil(p.extraMonths)})// plus any extra time (carry-over, gifted subscription, etc) they have. FIXME: moment can't add months in fractions...
    .toDate();
  p.extraMonths = 0; // clear extra time. If they subscribe again, it'll be recalculated from p.dateTerminated

  data.user.save(cb);
  if(isProduction) utils.txnEmail(data.user, 'cancel-subscription');
  utils.ga.event('unsubscribe', data.paymentMethod).send();
}

exports.buyGems = function(data, cb) {
  var amt = data.gift ? data.gift.gems.amount/4 : 5;
  (data.gift ? data.gift.member : data.user).balance += amt;
  data.user.purchased.txnCount++;
  if(isProduction) {
    if (!data.gift) utils.txnEmail(data.user, 'donation');
    utils.ga.event('checkout', data.paymentMethod).send();
    //TODO ga.transaction to reflect whether this is gift or self-purchase
    utils.ga.transaction(data.user._id, amt).item(amt, 1, data.paymentMethod.toLowerCase() + "-checkout", "Gems > " + data.paymentMethod).send();
  }
  if (data.gift) members.sendMessage(data.user, data.gift.member, data.gift);
  async.parallel([
    function(cb2){data.user.save(cb2)},
    function(cb2){data.gift ? data.gift.member.save(cb2) : cb2(null);}
  ], cb);
}

exports.validCoupon = function(req, res, next){
  mongoose.model('Coupon').findOne({_id:cc.validate(req.params.code), event:'google_6mo'}, function(err, coupon){
    if (err) return next(err);
    if (!coupon) return res.json(401, {err:"Invalid coupon code"});
    return res.send(200);
  });
}

exports.stripeCheckout = stripe.checkout;
exports.stripeSubscribeCancel = stripe.subscribeCancel;
exports.stripeSubscribeEdit = stripe.subscribeEdit;

exports.paypalSubscribe = paypal.createBillingAgreement;
exports.paypalSubscribeSuccess = paypal.executeBillingAgreement;
exports.paypalSubscribeCancel = paypal.cancelSubscription;
exports.paypalCheckout = paypal.createPayment;
exports.paypalCheckoutSuccess = paypal.executePayment;
exports.paypalIPN = paypal.ipn;

exports.iapAndroidVerify = iap.androidVerify;
exports.iapIosVerify = iap.iosVerify;