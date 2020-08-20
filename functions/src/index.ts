import * as functions from 'firebase-functions'
import * as admin from 'firebase-admin'

const BID_PROCESSED = 'Processed'
const DROPITEM_DROPPING = 'Dropping'
const DROPITEM_HOLD = 'On Hold'

"use strict"
admin.initializeApp()
const db = admin.firestore();
const log = functions.logger

export const processBid = functions.firestore
   .document('bids/{bidId}')
   .onCreate((snapshot, context) => {
   const bid = snapshot.data()
   if (!bid) {
      log.error("Bid does not exist") 
      return null
   }

   const dropItemDesc = "dropItems[id: " + bid.dropItemId + "]"
   log.info("Processing Bid on " + dropItemDesc)
   const dropItemRef = db.collection("dropItems").doc(bid.dropItemId);
   return dropItemRef.get().then(doc => {
      if (!doc.exists) {
         console.error("Doc does not exist for get " + dropItemDesc) 
         return null
      }

      const dropItem = doc.data()
      if (!dropItem) {
         console.error("Doc.data does not exist for get " + dropItemDesc)
         return null
      }

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
         .catch(error => { 
            console.error("Error setting " + timerDesc, error) 
            return null
         })
      })
      .catch(error => { 
         log.error("Error updating " + dropItemDesc, error) 
         return null
      })
   })
   .catch(error => { 
      log.error("Error getting " + dropItemDesc, error) 
      return null
   })  
})

export const processTimer = functions.firestore
   .document('timers/{timerId}')
   .onWrite(async (change, context) => {
      const timerDesc = "timers[id: " + context.params.timerId + "]"
      if (!change.after.exists) {
         log.info(timerDesc + " deleted")
         return null
      }

      const timer = change.after.data();
      if (!timer) {
         log.error(timerDesc + " data does not exist")
         return null
      }

      const nowTime = (new Date()).getTime();
      const dropDoneDate = timer.dropDoneDate;

      if (dropDoneDate < nowTime) { 
         log.info(timerDesc + " expired") 

         // update dropitem - it has the same id as the timer
         const dropItemId = context.params.timerId
         const dropItemDesc = "dropItems[id: " + dropItemId + "]"
         const dropItemRef = db.collection("dropItems").doc(dropItemId);
         log.info("Updating " + dropItemDesc + " to HOLD")
         return dropItemRef.update( { status: DROPITEM_HOLD }).then(() => {            
            log.info("Creating email")
            const htmlMsg =  
               "You are the high bidder on item <b>" + dropItemId + "</b>" + 
               "<p>Insert Mission Impossible theme song here</p>"
            const email =  { 
               to: ["andy_robbins@yahoo.com"],
               message: { subject: "Winning bid", html: htmlMsg }
            }
                 
            return db.collection("emails").add(email).then(() => {   
               console.log("Deleting " + timerDesc) 
               return change.after.ref.delete() 
            })
            .catch(error => { 
               console.error("Error updating " + dropItemDesc, error) 
               return null
            })
         })
         .catch(error => { 
            console.error("Error updating " + dropItemDesc, error) 
            return null
         })
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

// export const sendEmail = functions.firestore
//    .document('other/{otherId}')
//    .onCreate((snapshot, context) => {
//       const email = snapshot.data()
//       if (!email) {
//          log.error("Email does not exist") 
//          return null
//       }

//       const mailOptions = {
//          from: EMAIL_ADDRESS, 
//          to: "andy.robbins@gmail.com",
//          subject: "Emailer function test", 
//          html: 
//             `<p>This is a test of the email</p>
//             <br/>
//             <b>Hope it works </b>
//            ` 
//       }

//       transporter.sendMail(mailOptions, (error, info) => {
//          if (error) {
//             log.error("transporter.sendMail", EMAIL_ADDRESS, error)
//             return snapshot.ref.update({ status: EMAIL_ERROR, statusDetail: error.toString(), processedDate: Date.now() })
//          } else {
//             log.info("transporter.sendMail", EMAIL_ADDRESS, info)
//             return snapshot.ref.update({ status: EMAIL_PROCESSED, statusDetail:info.response, processedDate: Date.now() })
//          }
//       })
     
//       log.info("returning default null")
//       return null
// })

// const transporter = nodemailer.createTransport({
//    host: 'smtp.mail.yahoo.com',
//    port: 465,
//    service:'yahoo',
//    secure: false,
//    auth: {
//        user: EMAIL_ADDRESS,
//        pass: EMAIL_PASSWORD
//    }
// })
