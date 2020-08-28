import * as functions from 'firebase-functions'
import * as admin from 'firebase-admin'

const DROPEX_HREF = "href=http://dropex.4th.host/"  
const BID_PROCESSED = 'Processed'
const ITEM_DROPPING = 'Dropping'
const ITEM_HOLD = 'On Hold'

"use strict"
admin.initializeApp()
const db = admin.firestore()
const log = functions.logger

export const processBid = functions.firestore
   .document('bids/{bidId}')
   .onCreate((snapshot, context) => {
   const bid = snapshot.data()
   if (!bid) { logError("Bid does not exist") }

   const itemDesc = "items[id: " + bid.itemId + "]"
   log.info("Processing Bid on " + itemDesc)
   const itemRef = db.collection("items").doc(bid.itemId);
   return itemRef.get().then(doc => {
      if (!doc.exists) { return logError("Doc does not exist for get of " + itemDesc) }
      const item = doc.data()
      if (!item) { return logError("Doc.data does not exist for get of " + itemDesc) }

      log.info("Processing " + itemDesc)
      const bidProcessedDate = Date.now()
      // todo - read drop each time?  tramp data on bid?
      const extensionSeconds = 30
      const dropDoneDate = bidProcessedDate + extensionSeconds * 1000

      let itemUpdate = { }
      if (item.buyPrice < bid.amount) {
         itemUpdate = { 
            buyPrice: bid.amount, 
            bidderIds: admin.firestore.FieldValue.arrayUnion(bid.userId),
            currBidderId: bid.userId, 
            lastUserActivityDate: bidProcessedDate, 
            dropDoneDate: dropDoneDate,
            status: ITEM_DROPPING,
         }
      }
      else {
         itemUpdate = { bidderIds: admin.firestore.FieldValue.arrayUnion(bid.userId) }
      }

      return itemRef.update(itemUpdate).then(() => { 
         // set timer
         const timerDesc = "timers[id: " + bid.itemId + "]"
         const timerRef = db.collection("timers").doc(bid.itemId)
         log.info("Setting " + timerDesc)
         return timerRef.set({ dropDoneDate: dropDoneDate }).then(() => { 
            console.log("Updating bid on " + itemDesc)
            return snapshot.ref.update({ status: BID_PROCESSED, processedDate: bidProcessedDate })
         })
         .catch(error => { return logError("Error setting " + timerDesc, error) })
      })
      .catch(error => { return logError("Error updating " + itemDesc, error) })
   })
   .catch(error => { return logError("Error getting " + itemDesc, error) })  
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
         return updateItem(change, context)
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

async function updateItem(change: any, context: any) {
   // timer.id is copied from item.id
   const itemId = context.params.timerId
   const itemDesc = "items[id: " + itemId + "]"
   const itemRef = db.collection("items").doc(itemId);

   log.info("Getting " + itemDesc)
   return itemRef.get().then(doc => {
      if (!doc.exists) { return logError("Doc does not exist for get of " + itemDesc) }
      const item = doc.data()
      if (!item) { return logError("Doc.data does not exist for get of " + itemDesc) }
 
      const userId = item.currBidderId
      const userDesc = "users[id: " + userId + "]"
      log.info("Getting " + userDesc)
      const userRef = db.collection("users").doc(userId);
      return userRef.get().then(userDoc => {
         if (!userDoc.exists) { return logError("Doc does not exist for get of " + userDesc) }
         const user = userDoc.data()
         if (!user) { return logError("Doc.data does not exist for get of " + userDesc) }
    
         const userName = user.firstName + 
            (user.firstName.length > 0 && user.lastName.length > 0 ? " " : "")  + 
            user.lastName
         log.info("Updating " + itemDesc)
         const itemUpdate = { status: ITEM_HOLD, buyerId: item.currBidderId, buyerName: userName }               
         return itemRef.update(itemUpdate).then(() => {        
            const timerDesc = "timers[id: " + context.params.timerId + "]"
            console.log("Deleting " + timerDesc) 
            return change.after.ref.delete().then(() => {   
               const htmlMsg =  
                  "You are the high bidder on item " + itemLink(item.id, item.name)
                 "<p>You will be contacted with the location of the alley in which to deliver the briefcase full of cash</p>"
               const subject = "Winning bid"
               
               return sendEmail(userId, subject, htmlMsg)
               .catch(error => { return logError("Error sending Email", error) }) 
            })
         })
         .catch(error => { return logError("Error updating " + itemDesc, error) })
      })
      .catch(error => { return logError("Error getting " + userDesc, error) })
   })
   .catch(error => { return logError("Error getting " + itemDesc, error) })
}

// todo - handle create/update
// if new status is Created or Sent, send email and set status to Sent
// if new status is Paid, then mark items as Sold            
export const processInvoice = functions.firestore
   .document('invoices/{invoiceId}')
   .onCreate((snapshot, context) => {
   const invoice = snapshot.data()
   if (!invoice) { return logError("Invoice does not exist") }

   const invoiceDesc = "invoices[id: " + invoice.id + "]"
   let itemText = ''
   let itemId = null
   for (var item of invoice.items) {
      if (itemText.length == 0) { itemId = item.id }
      else {
         itemText += ", " 
         itemId = null
      }
      itemText += item.name
   }

   const link = itemId ? itemLink(itemId, itemText) : "<a " + DROPEX_HREF + ">" + itemText + "</a>"  
   const htmlMsg = "Here is you invoice for " + link
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
         from: "Dropzone <dropzone@4th.host>",
         message: { subject: subject, html: htmlMsg }
      }
      return db.collection("emails").add(email)
      .catch(error => { throw logReturnError("Error adding Email", error) })   
   })
   .catch(error => { throw logReturnError("Error getting " + authUserDesc, error) })
}

function itemLink(itemId: string, itemName: string) {
   return ("<a " + DROPEX_HREF + "#/item/" + itemId + ">" + itemName + "</a>")   
}

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