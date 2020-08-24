import * as functions from 'firebase-functions'
import * as admin from 'firebase-admin'

const BID_PROCESSED = 'Processed'
const DROPITEM_DROPPING = 'Dropping'
const DROPITEM_HOLD = 'On Hold'

"use strict"
admin.initializeApp()
const db = admin.firestore()
const log = functions.logger

export const processBid = functions.firestore
   .document('bids/{bidId}')
   .onCreate((snapshot, context) => {
   const bid = snapshot.data()
   if (!bid) { logError("Bid does not exist") }

   const dropItemDesc = "dropItems[id: " + bid.dropItemId + "]"
   log.info("Processing Bid on " + dropItemDesc)
   const dropItemRef = db.collection("dropItems").doc(bid.dropItemId);
   return dropItemRef.get().then(doc => {
      if (!doc.exists) { return logError("Doc does not exist for get of " + dropItemDesc) }
      const dropItem = doc.data()
      if (!dropItem) { return logError("Doc.data does not exist for get of " + dropItemDesc) }

      log.info("Processing " + dropItemDesc)
      const bidProcessedDate = Date.now()
      // todo - read drop each time?  tramp data on bid?
      const extensionSeconds = 30
      const dropDoneDate = bidProcessedDate + extensionSeconds * 1000

      let dropItemUpdate = { }
      if (dropItem.currPrice < bid.amount) {
         dropItemUpdate = { 
            bidders: admin.firestore.FieldValue.arrayUnion(bid.userId),
            currPrice: bid.amount, 
            currBidderId: bid.userId, 
            lastUserActivityDate: bidProcessedDate, 
            dropDoneDate: dropDoneDate,
            status: DROPITEM_DROPPING,
         }
      }
      else {
         dropItemUpdate = { bidders: admin.firestore.FieldValue.arrayUnion(bid.userId) }
      }

      return dropItemRef.update(dropItemUpdate).then(() => { 
         // set timer
         const timerDesc = "timers[id: " + bid.dropItemId + "]"
         const timerRef = db.collection("timers").doc(bid.dropItemId)
         log.info("Setting " + timerDesc)
         return timerRef.set({ dropDoneDate: dropDoneDate }).then(() => { 
            console.log("Updating bid on " + dropItemDesc)
            return snapshot.ref.update({ status: BID_PROCESSED, processedDate: bidProcessedDate })
         })
         .catch(error => { return logError("Error setting " + timerDesc, error) })
      })
      .catch(error => { return logError("Error updating " + dropItemDesc, error) })
   })
   .catch(error => { return logError("Error getting " + dropItemDesc, error) })  
})

export const processTimer = functions.firestore
   .document('timers/{timerId}')
   .onWrite(async (change, context) => {
      const timerDesc = "timers[id: " + context.params.timerId + "]"
      if (!change.after.exists) { return logInfo(timerDesc + " deleted") } 

      const timer = change.after.data();
      if (!timer) { return logError(timerDesc + " data does not exist") }

      const nowTime = (new Date()).getTime();
      const dropDoneDate = timer.dropDoneDate;
      if (dropDoneDate < nowTime) { 
         log.info(timerDesc + " expired") 
         return updateDropItem(change, context)
      }
      else {
         let remainingSeconds = Math.floor((dropDoneDate - nowTime)/1000)
         const sleepTime = remainingSeconds > 10 ? 2000 : 1000
         await sleep(sleepTime)
         remainingSeconds = Math.floor((dropDoneDate - nowTime)/1000)
         return change.after.ref.update({ remainingSeconds: remainingSeconds })
      }
})

async function sleep(ms: number) {
   return new Promise(resolve => setTimeout(resolve, ms));
}

async function updateDropItem(change: any, context: any) {
   // timer.id is copied from dropitem.id
   const dropItemId = context.params.timerId
   const dropItemDesc = "dropItems[id: " + dropItemId + "]"
   const dropItemRef = db.collection("dropItems").doc(dropItemId);

   log.info("Getting " + dropItemDesc)
   return dropItemRef.get().then(doc => {
      if (!doc.exists) { return logError("Doc does not exist for get of " + dropItemDesc) }
      const dropItem = doc.data()
      if (!dropItem) { return logError("Doc.data does not exist for get of " + dropItemDesc) }
 
      const userId = dropItem.currBidderId
      const userDesc = "users[id: " + userId + "]"
      log.info("Getting " + userDesc)
      const userRef = db.collection("users").doc(userId);
      return userRef.get().then(userDoc => {
         if (!userDoc.exists) { return logError("Doc does not exist for get of " + userDesc) }
         const user = userDoc.data()
         if (!user) { return logError("Doc.data does not exist for get of " + userDesc) }
    
         const userFullName = user.firstName + 
            (user.firstName.length > 0 && user.lastName.length > 0 ? " " : "")  + 
            user.lastName
         log.info("Updating " + dropItemDesc)
         const dropItemUpdate = { status: DROPITEM_HOLD, buyerId: dropItem.currBidderId, buyerName: userFullName }               
         return dropItemRef.update(dropItemUpdate).then(() => {        
            const timerDesc = "timers[id: " + context.params.timerId + "]"
            console.log("Deleting " + timerDesc) 
            return change.after.ref.delete().then(() => {   
               const htmlMsg =  
                  "You are the high bidder on item <a href=http://dropex.4th.host>" + dropItem.name + "</a>" + 
                  "<p>You will be contacted with the location of the alley in which to deliver the briefcase full of cash</p>"
               const subject = "Winning bid"
               
               return sendEmail(userId, subject, htmlMsg)
               .catch(error => { return logError("Error sending Email", error) }) 
            })
         })
         .catch(error => { return logError("Error updating " + dropItemDesc, error) })
      })
      .catch(error => { return logError("Error getting " + userDesc, error) })
   })
   .catch(error => { return logError("Error getting " + dropItemDesc, error) })
}

export const processInvoice = functions.firestore
   .document('invoices/{invoiceId}')
   .onCreate((snapshot, context) => {
   const invoice = snapshot.data()
   if (!invoice) { return logError("Invoice does not exist") }

   const invoiceDesc = "invoices[id: " + invoice.id + "]"
   let itemText = ''
   for (var item of invoice.items) {
      if (itemText.length > 0) { itemText += ", " }
      itemText += item.name
   }

   const htmlMsg = "Here is you invoice for <a href=http://dropex.4th.host>" + itemText + "</a>" 
   return sendEmail(invoice.userId, "Invoice", htmlMsg).then(() => {
      console.log("Updating invoice " + invoiceDesc)
      return snapshot.ref.update({ status: "Sent", sentDate: Date.now() })
   })
   .catch(error => { return logError("Error sending Email", error) }) 
})


async function sendEmail(userId: string, subject: string, htmlMsg: string) {
   const authUserDesc = "authUser[id: " + userId + "]"
   log.info("Getting " + authUserDesc)

   return admin.auth().getUser(userId).then(userRecord => {
      log.info("Creating email")
      const email =  { 
         to: [userRecord.email],
         from: "Dropmaster <dropmaster@4th.host>",
         message: { subject: subject, html: htmlMsg }
      }
      return db.collection("emails").add(email)
      .catch(error => { throw logReturnError("Error adding Email", error) })   
   })
   .catch(error => { throw logReturnError("Error getting " + authUserDesc, error) })
}

// async function sendEmailOld(userId: string, subject: string, htmlMsg: string) {
//    const authUserDesc = "authUser[id: " + userId + "]"
//    log.info("Getting " + authUserDesc)
   
//    return admin.auth().getUser(userId).then(userRecord => {
//       log.info("Creating email")
//       const email =  { 
//          to: [userRecord.email],
//          from: "Dropmaster <dropmaster@4th.host>",
//          message: { subject: subject, html: htmlMsg }
//       }
//       return db.collection("emails").add(email)
//       .catch(error => { return logError("Error adding Email", error) })   
//    })
//    .catch(error => { return logError("Error getting " + authUserDesc, error) })
// }

// convenience methods to log and return
function logInfo(msg: string) {
   log.info(msg)
   return null
}

function logError(msg: string, error: any = null) {
   if (error) { log.error(msg, error)}
   else { log.error(msg) }

   return null
}

function logReturnError(msg: string, error: any) {
   if (error) { log.error(msg, error)}
   else { log.error(msg) }

   return error
}