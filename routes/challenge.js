const express = require('express');
const router = express.Router();
const { db, admin } = require('../config/firestore');
const QreditService = require('../services/qreditService');

const { chunkText, parseBufferToText, downloadFileBytes, inferFileTypeFromName } = require('../utils/fileUtils');
// Assuming you export generateLearningModule from your tutorialService or llmUtils
const { generateLearningModule } = require('../services/tutorialService'); 

// 1. INITIALIZE (Creates the Draft)
router.post('/init', async (req, res) => {
  try {
    const { userId, title, description, durationHours, scope, startsAt } = req.body;

    const userRef = db.collection('users').doc(userId);
    const userSnap = await userRef.get();
    if (!userSnap.exists) return res.status(404).json({ error: 'User not found' });
    
    const userData = userSnap.data();

    // ⚡ NEW: Scope Validation
    // Prevent users from creating scoped challenges if their profile is incomplete
    if (scope === 'school' && !userData.school) {
      return res.status(400).json({ error: 'Please update your profile with your school to host a school-wide Arena.' });
    }
    if (scope === 'department' && !userData.department) {
      return res.status(400).json({ error: 'Please update your profile with your department to host a department-wide Arena.' });
    }
    if (scope === 'level' && !userData.level) {
      return res.status(400).json({ error: 'Please update your profile with your academic level to host a level-wide Arena.' });
    }

    // ⚡ FIX: Hierarchical Scope Cascading
    // 1. If it's not global, always lock the school.
    const targetSchool = scope !== 'global' ? (userData.school || null) : null;

    // 2. If it's a Department OR a Level Arena, lock the department!
    const targetDept = (scope === 'department' || scope === 'level') ? (userData.department || null) : null;

    // 3. Only lock the level if explicitly requested.
    const targetLevel = scope === 'level' ? (userData.level || null) : null;

    const challengeRef = db.collection('challenges').doc();
    const startTime = admin.firestore.Timestamp.fromMillis(startsAt);
    const endsAt = admin.firestore.Timestamp.fromMillis(startsAt + (durationHours * 3600000));

    await challengeRef.set({
      creatorId: userId,
      creatorName: userData.username || 'Scholar',
      title,
      description,
      scope,
      targetSchool,
      targetDept,
      targetLevel,
      inviteCode: challengeRef.id.substring(0, 6).toUpperCase(),
      prizePool: 0,
      status: 'draft', 
      startsAt: startTime,
      endsAt: endsAt,
      createdAt: admin.firestore.Timestamp.now(),
      materials: [], 
      totalModulesCount: 0 
    });

    res.json({ success: true, challengeId: challengeRef.id });
  } catch (error) {
    console.error("Init Error:", error);
    res.status(500).json({ error: error.message });
  }
});

// 2. ADD MATERIAL (The Sequential Loader)
router.post('/add_material', async (req, res) => {
  try {
    const { challengeId, userId, rawText, fileUrl, fileName } = req.body;

    // A. Verify Draft State
    const challengeRef = db.collection('challenges').doc(challengeId);
    const challengeSnap = await challengeRef.get();
    
    if (!challengeSnap.exists || challengeSnap.data().creatorId !== userId) {
      return res.status(403).json({ error: 'Unauthorized or not found' });
    }
    if (challengeSnap.data().status !== 'draft') {
      return res.status(400).json({ error: 'Challenge is already published' });
    }
    if (challengeSnap.data().materials.length >= 5) {
      return res.status(400).json({ error: 'Maximum of 5 materials reached' });
    }

    // B. Extract Text
    let text = rawText || '';
    if (fileUrl) {
      const fileBuffer = await downloadFileBytes(fileUrl);
      const fileType = inferFileTypeFromName(fileName || fileUrl);
      text = await parseBufferToText(fileBuffer, fileType);
    }
    
    const paragraphs = chunkText(text);
    if (paragraphs.length === 0) throw new Error('No readable text found.');

    // C. Generate Modules via Gemini
    const username = challengeSnap.data().creatorName;
    const modules = await Promise.all(
      paragraphs.map((paragraph, index) => generateLearningModule(paragraph, index, username))
    );

    const newMaterial = {
      id: db.collection('challenges').doc().id, // Generate a unique ID for this material
      fileName: fileName || 'Untitled Module',
      modules: modules,
      moduleCount: modules.length
    };

    // D. Append to Draft
    await challengeRef.update({
      materials: admin.firestore.FieldValue.arrayUnion(newMaterial),
      totalModulesCount: admin.firestore.FieldValue.increment(modules.length)
    });

    res.json({ success: true, material: newMaterial });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /challenge/remove_material
router.post('/remove_material', async (req, res) => {
  try {
    const { challengeId, userId, materialId } = req.body;
    const challengeRef = db.collection('challenges').doc(challengeId);

    await db.runTransaction(async (tx) => {
      const snap = await tx.get(challengeRef);
      if (!snap.exists) throw new Error('Challenge not found');

      const challenge = snap.data();
      if (challenge.creatorId !== userId) throw new Error('Unauthorized');
      if (challenge.status !== 'draft') throw new Error('Cannot edit published challenge');

      // Find the exact material to remove
      const materialToRemove = challenge.materials.find(m => m.id === materialId);
      if (!materialToRemove) throw new Error('Material not found');

      // Remove it from the array AND decrement the module count atomically
      tx.update(challengeRef, {
        materials: admin.firestore.FieldValue.arrayRemove(materialToRemove),
        totalModulesCount: admin.firestore.FieldValue.increment(-materialToRemove.moduleCount)
      });
    });

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// 3. PUBLISH (Locks the Draft, Deducts Fee, and Auto-Joins Creator)
router.post('/publish', async (req, res) => {
  const { challengeId, userId } = req.body;
  const challengeRef = db.collection('challenges').doc(challengeId);
  const userRef = db.collection('users').doc(userId);

  try {
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(challengeRef);
      const userSnap = await tx.get(userRef);
      
      if (!snap.exists) throw new Error('Challenge not found');
      if (!userSnap.exists) throw new Error('User not found');
      
      const challenge = snap.data();
      const user = userSnap.data();
      
      if (challenge.creatorId !== userId) throw new Error('Unauthorized');
      if (challenge.status !== 'draft') throw new Error('Already published');
      if (challenge.materials.length === 0) throw new Error('Add at least 1 material');

      // 1. Calculate 50% generation fee
      // Assume a base cost of 10 Qredits per module. The creator pays 50% of that total cost.
      const baseCostPerModule = 1; 
      const totalModulesCost = challenge.totalModulesCount * baseCostPerModule;
      const creatorBurden = Math.ceil(totalModulesCost * 0.5);
      const prizePoolContribution = Math.round(creatorBurden * 0.70);

      // 2. Deduct fee (Throws INSUFFICIENT_FUNDS if they can't afford it)
      if ((user.qredit_balance || 0) < creatorBurden) {
        throw new Error('INSUFFICIENT_FUNDS');
      }
      tx.update(userRef, {
        qredit_balance: admin.firestore.FieldValue.increment(-creatorBurden)
      });

      // 3. Lock Challenge state
      tx.update(challengeRef, {
        status: 'pending', 
        generationCostPaid: creatorBurden,
        prizePool: admin.firestore.FieldValue.increment(prizePoolContribution)
      });

      // ==========================================
      // ⚡ POINT 1: AUTO-JOIN THE CREATOR
      // ==========================================
      
      // Register Creator as Participant
      const participantRef = challengeRef.collection('participants').doc(userId);
      tx.set(participantRef, {
        displayName: user.username || 'Scholar',
        school: user.school || null,
        department: user.department || null,
        joinedAt: admin.firestore.FieldValue.serverTimestamp(),
        liveProgressPercentage: 0,
        currentMaterialIndex: 0,
        performance: {},
        totalCompetitiveScore: 0,
        lastProgressUpdate: admin.firestore.FieldValue.serverTimestamp()
      });

      // Copy Materials to Creator's cache
      const userTutorialsRef = userRef.collection('tutorials');
      if (challenge.materials && Array.isArray(challenge.materials)) {
        challenge.materials.forEach((material, index) => {
          const materialDocId = material.id || `${challengeId}_mat_${index}`; 
          const newTutRef = userTutorialsRef.doc(materialDocId);
          tx.set(newTutRef, {
            userId: userId,
            fileName: material.fileName || `Arena Module ${index + 1}`,
            expireAt: challenge.endsAt || null, 
            startsAt: challenge.startsAt || null,          
            modules: material.modules || [], 
            challengeId: challengeId, // Note: using actual challengeId here
            challengeTitle: challenge.title,
            materialIndex: index, 
            completed: false,
            currentIndex: 0,
            score: 0,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            lastSeenAt: admin.firestore.FieldValue.serverTimestamp()
          });
        });
      }
    });

    res.json({ success: true });
  } catch (error) {
    res.status(error.message === 'INSUFFICIENT_FUNDS' ? 402 : 500).json({ error: error.message });
  }
});

router.post('/join', async (req, res) => {
  const { userId, challengeId } = req.body; // challengeId here is actually the 6-char Invite Code from Flutter
  
  try {
    // 1. Find the actual document by Invite Code
    const querySnap = await db.collection('challenges').where('inviteCode', '==', challengeId).get();
    if (querySnap.empty) throw new Error('Invalid Invite Code');
    
    const challengeRef = querySnap.docs[0].ref;
    const actualChallengeId = challengeRef.id;
    const userRef = db.collection('users').doc(userId);
    const participantRef = challengeRef.collection('participants').doc(userId);
    
    await db.runTransaction(async (tx) => {
      // ==========================================
      // 🛑 READ PHASE (Must happen first)
      // ==========================================
      const challengeSnap = await tx.get(challengeRef);
      const userSnap = await tx.get(userRef);
      const participantSnap = await tx.get(participantRef);

      if (!challengeSnap.exists) throw new Error('Challenge not found');
      
      const challenge = challengeSnap.data();
      const user = userSnap.data();
      
      const now = admin.firestore.Timestamp.now();
      if (now.toMillis() >= challenge.endsAt.toMillis()) {
        throw new Error('Can\'t join. This Arena has already ended.');
      }
      
      if (participantSnap.exists) throw new Error('Already joined');

      // 1. Scope Validation Engine (Hierarchical Cascade)
      
      // A. If the Arena is locked to a specific School (Applies to School, Dept, and Level scopes)
      if (challenge.targetSchool && user.school !== challenge.targetSchool) {
        throw new Error('You are not in the permitted university for this Arena.');
      }
      
      // B. If the Arena is locked to a specific Department (Applies to Dept and Level scopes)
      if (challenge.targetDept && user.department !== challenge.targetDept) {
        throw new Error('You are not in the permitted department for this Arena.');
      }
      
      // C. If the Arena is locked to a specific Level (Applies ONLY to Level scopes)
      if (challenge.targetLevel && user.level !== challenge.targetLevel) {
        throw new Error('You are not in the permitted academic level for this Arena.');
      }

      // 2. Billing Calculation
      // ==========================================
      // ⚡ POINT 3 (UPDATED): PLATFORM TAX & PRIZE POOL
      // ==========================================
      const modulesCount = challenge.totalModulesCount || 0;
      const baseCostPerModule = 1; 
      const totalModulesCost = modulesCount * baseCostPerModule;
      
      // The total amount the user will be charged
      const entryFee = Math.ceil(totalModulesCost * 0.5);

      if ((user.qredit_balance || 0) < entryFee) {
        throw new Error(`Insufficient Qredits. Required: ${entryFee}`);
      }

      // 1. Calculate the Split (e.g., 70% to Prize Pool, 30% to Qlearit)
      // You can adjust the 0.70 multiplier to whatever profit margin you want!
      const prizePoolContribution = Math.round(entryFee * 0.70);
      const platformRevenue = entryFee - prizePoolContribution; 

      // 2. Deduct the FULL entry fee from the User
      tx.update(userRef, { 
        qredit_balance: admin.firestore.FieldValue.increment(-entryFee) 
      });

      // 3. Add ONLY the player's contribution to the Arena's Prize Pool
      tx.update(challengeRef, { 
        prizePool: admin.firestore.FieldValue.increment(prizePoolContribution) 
      });

      // (Optional) If you have an admin statistics document, you could log the `platformRevenue` here!
      // ==========================================
      // ✅ WRITE PHASE (Must happen last)
      // ==========================================
      

      // 5. Register the Participant
      tx.set(participantRef, {
        displayName: user.username || 'Scholar',
        school: user.school || null,
        department: user.department || null,
        joinedAt: admin.firestore.FieldValue.serverTimestamp(),
        liveProgressPercentage: 0,
        currentMaterialIndex: 0,
        performance: {},
        totalCompetitiveScore: 0,
        lastProgressUpdate: admin.firestore.FieldValue.serverTimestamp()
      });

      // 6. Copy the Arena Materials into the user's personal tutorials cache
      // ⚡ RESTORED SCHEMA: We must use the exact fields your Flutter Carousel expects!
      const userTutorialsRef = db.collection('users').doc(userId).collection('tutorials');
      
      if (challenge.materials && Array.isArray(challenge.materials)) {
        challenge.materials.forEach((material, index) => {
          // Create a unique deterministic ID for each piece of material
          const materialDocId = material.id || `${actualChallengeId}_mat_${index}`; 
          const newTutRef = userTutorialsRef.doc(materialDocId);
          
          tx.set(newTutRef, {
            userId: userId,                               // ⚡ Required by your standard schema
            fileName: material.fileName || `Arena Module ${index + 1}`, // ⚡ Flutter needs 'fileName', NOT 'title'!
            expireAt: challenge.endsAt || null, 
            startsAt: challenge.startsAt || null,          
            modules: material.modules || [],              // ⚡ The actual content
            challengeId: actualChallengeId, 
            challengeTitle: challenge.title,              // ⚡ Required for the Arena Quick-Link
            materialIndex: index,                         // ⚡ Required for Live Progress Tracking
            completed: false,
            currentIndex: 0,
            score: 0,
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            lastSeenAt: admin.firestore.FieldValue.serverTimestamp()
          });
        });
      }

    }); // <-- End of Transaction

    res.json({ success: true, message: 'Entered the Arena successfully.' });

  } catch (error) {
    res.status(400).json({ error: error.message });
  }
});


// POST /challenge/progress
router.post('/progress', async (req, res) => {
    try {
      const { userId, challengeId, progressPercentage, materialIndex } = req.body;
      
      // Fire-and-forget update for high-throughput live tracking
      const participantRef = db.collection('challenges').doc(challengeId)
                               .collection('participants').doc(userId);
  
      await participantRef.update({
        liveProgressPercentage: progressPercentage,
        currentMaterialIndex: materialIndex,
        lastProgressUpdate: admin.firestore.FieldValue.serverTimestamp()
      });
  
      res.json({ success: true });
    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });
  
// POST /challenge/submit_quiz
router.post('/submit_quiz', async (req, res) => {
  // ⚡ Extract the dynamic score and userId from Flutter
  const { userId, challengeId, tutorialId, answers, score } = req.body;
  
  try {
    if (!userId) throw new Error('Missing userId in request');

    // 1. Trust the score sent from the frontend MVP
    const finalScore = score !== undefined ? Number(score) : 0;
    const passed = finalScore >= 50;

    // 2. Lock the First Attempt Score using a Transaction
    const participantRef = db.collection('challenges').doc(challengeId).collection('participants').doc(userId);
    
    await db.runTransaction(async (tx) => {
      const snap = await tx.get(participantRef);
      if (!snap.exists) throw new Error('Participant not found');
      
      const data = snap.data();
      const existingPerformance = data.performance[tutorialId];

      // Anti-Cheat: Only write if this material hasn't been scored yet
      if (!existingPerformance || existingPerformance.firstAttemptScore === null) {
        
        const newPerformanceMap = {
          ...data.performance,
          [tutorialId]: {
            firstAttemptScore: finalScore, // ⚡ Uses the score from Flutter
            isCompleted: passed,
            completedAt: admin.firestore.FieldValue.serverTimestamp()
          }
        };

        // Calculate new total competitive score
        const newTotalScore = Object.values(newPerformanceMap)
          .reduce((sum, material) => sum + (material.firstAttemptScore || 0), 0);

        tx.update(participantRef, {
          performance: newPerformanceMap,
          totalCompetitiveScore: newTotalScore,
          lastProgressUpdate: admin.firestore.FieldValue.serverTimestamp()
        });
      }
    });

    res.json({ success: true, score: finalScore, passed, locked: true });

  } catch (error) {
    console.error('Submit Quiz Error:', error);
    res.status(500).json({ error: error.message });
  }
});

  // POST /challenge/finalize
router.post('/finalize', async (req, res) => {
    const { challengeId } = req.body;
    const challengeRef = db.collection('challenges').doc(challengeId);
  
    try {
      await db.runTransaction(async (tx) => {
        // ==========================================
        // 🛑 READ PHASE (Must happen first)
        // ==========================================
        const challengeSnap = await tx.get(challengeRef);
        if (!challengeSnap.exists) throw new Error('Challenge not found');
        
        const challenge = challengeSnap.data();
  
        // 1. Double-Check Status & Time
        if (challenge.status !== 'active' && challenge.status !== 'pending') {
          throw new Error('Challenge is already closed or evaluating.');
        }
        
        const now = admin.firestore.Timestamp.now();
        if (now.toMillis() < challenge.endsAt.toMillis()) {
          throw new Error('Challenge has not ended yet.');
        }
  
        // ⚡ FIX: Fetch Participants HERE, before any writes occur!
        const participantsRef = challengeRef.collection('participants');
        const participantsSnap = await tx.get(participantsRef);
  
        // ==========================================
        // ✅ WRITE PHASE (Must happen last)
        // ==========================================
  
        // 2. Lock the Challenge state
        tx.update(challengeRef, { status: 'evaluating' });
  
        // 3. Rank Participants
        let players = [];
        participantsSnap.forEach(doc => {
          players.push({ id: doc.id, ...doc.data() });
        });
  
        // Sort by Highest Score first. Tie-breaker: Who finished earliest
        players.sort((a, b) => {
          if (b.totalCompetitiveScore !== a.totalCompetitiveScore) {
            return b.totalCompetitiveScore - a.totalCompetitiveScore; 
          }
          const timeA = a.lastProgressUpdate ? a.lastProgressUpdate.toMillis() : Infinity;
          const timeB = b.lastProgressUpdate ? b.lastProgressUpdate.toMillis() : Infinity;
          return timeA - timeB;
        });
  
        const totalPool = challenge.prizePool;
        const winners = [];
  
       // 4. Distribute the Pool
       if (players.length > 0 && totalPool > 0) {
          
        // ⚡ FIX: Calculate precise splits, and give any lost remainders to the winner!
        let p1 = Math.round(totalPool * 0.60); // 1st Place
        let p2 = Math.round(totalPool * 0.30); // 2nd Place
        let p3 = Math.round(totalPool * 0.10); // 3rd Place
        
        const remainder = totalPool - (p1 + p2 + p3);
        p1 += remainder; // Give leftover fractions to 1st place
        
        const payouts = [p1, p2, p3];

        for (let i = 0; i < Math.min(players.length, 3); i++) {
            const winnerId = players[i].id;
            const payoutAmount = payouts[i];
            
            if (payoutAmount > 0) {
               const userRef = db.collection('users').doc(winnerId);
               
               // Safely increment their balance
               tx.update(userRef, {
                 qredit_balance: admin.firestore.FieldValue.increment(payoutAmount)
               });
               
               // Log the transaction for the winner
               const txnRef = userRef.collection('transactions').doc();
               tx.set(txnRef, {
                  type: 'prize_winnings',
                  amount: payoutAmount,
                  description: `Arena Winner (Rank ${i + 1}): ${challenge.title}`,
                  created_at: admin.firestore.FieldValue.serverTimestamp()
               });
  
               winners.push({ rank: i + 1, userId: winnerId, payout: payoutAmount });
            }
          }
        }
  
        // 5. Finalize the Challenge Document
        tx.update(challengeRef, { 
          status: 'closed',
          winners: winners, 
          closedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      });
  
      res.json({ success: true, message: 'Arena finalized and prizes distributed.' });
  
    } catch (error) {
      console.error('Finalize Error:', error);
      res.status(500).json({ error: error.message });
    }
  });

  module.exports = router;