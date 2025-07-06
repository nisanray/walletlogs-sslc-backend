const express = require('express');
const axios = require('axios');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();

app.use(cors({ origin: '*' }));
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// In-memory store (not for production)
const paymentStatusMap = {}; // { tran_id: status }
const paymentDataMap = {}; // { tran_id: payment_data }

app.post('/initiate-payment', async (req, res) => {
  const { 
    amount, 
    email, 
    planId, 
    planName, 
    userId, 
    customerName, 
    customerPhone, 
    customerAddress,
    appVersion,
    deviceType 
  } = req.body;

  if (!amount || !email || !planId || !planName || !userId) {
    return res.status(400).json({ 
      error: 'Missing required fields: amount, email, planId, planName, userId' 
    });
  }

  const tran_id = `WL_${planId}_${userId}_${Date.now()}`;
  
  // Store payment data for reference
  paymentDataMap[tran_id] = {
    planId,
    planName,
    userId,
    amount,
    email,
    customerName: customerName || 'Customer',
    customerPhone: customerPhone || '01700000000',
    customerAddress: customerAddress || 'Dhaka',
    appVersion: appVersion || '1.0.0',
    deviceType: deviceType || 'unknown',
    initiatedAt: new Date().toISOString()
  };

  const payload = {
    store_id: 'patua685d01b8d4ca6',
    store_passwd: 'patua685d01b8d4ca6@ssl',
    total_amount: amount,
    currency: 'BDT',
    tran_id,
    success_url: 'http://localhost:3000/success',
    fail_url: 'http://localhost:3000/fail',
    cancel_url: 'http://localhost:3000/cancel',
    ipn_url: 'http://localhost:3000/ipn', // IPN endpoint
    cus_name: customerName || 'Customer',
    cus_email: email,
    cus_phone: customerPhone || '01700000000',
    cus_add1: customerAddress || 'Dhaka',
    cus_city: 'Dhaka',
    cus_postcode: '1212',
    cus_country: 'Bangladesh',
    shipping_method: 'NO',
    num_of_item: 1,
    product_name: `WalletLogs ${planName} Plan`,
    product_category: 'Digital Services',
    product_profile: 'general',
  };

  try {
    const params = new URLSearchParams(payload).toString();

    const response = await axios.post(
      'https://sandbox.sslcommerz.com/gwprocess/v4/api.php',
      params,
      {
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }
    );

    if (response.data?.status === 'SUCCESS') {
      // Store status as pending (in memory for demo)
      paymentStatusMap[tran_id] = 'PENDING';

      return res.json({
        GatewayPageURL: response.data.GatewayPageURL,
        transactionId: tran_id,
        paymentData: paymentDataMap[tran_id],
        sessionKey: response.data.sessionkey || null
      });
    } else {
      return res.status(400).json({
        error: 'Failed to generate payment URL',
        debug: response.data,
      });
    }
  } catch (error) {
    console.error('Payment initiation error:', error.message);
    return res.status(500).json({ error: 'Server error while initiating payment' });
  }
});

app.post('/ipn', async (req, res) => {
  const { tran_id, status, amount, currency, bank_tran_id, card_type } = req.body;

  if (!tran_id || !status) {
    return res.status(400).send('Missing transaction ID or status');
  }

  try {
    // Store comprehensive status in memory
    paymentStatusMap[tran_id] = {
      status,
      amount: amount || null,
      currency: currency || 'BDT',
      bank_tran_id: bank_tran_id || null,
      card_type: card_type || null,
      processedAt: new Date().toISOString(),
      paymentData: paymentDataMap[tran_id] || null
    };
    
    console.log(`IPN received: ${tran_id} → ${status}`, {
      amount,
      currency,
      bank_tran_id,
      card_type,
      paymentData: paymentDataMap[tran_id]
    });
    
    res.status(200).send('OK');
  } catch (err) {
    console.error('Error handling IPN:', err.message);
    res.status(500).send('Failed to process IPN');
  }
});

// Enhanced payment status endpoint with auto-checking
app.get('/payment-status/:tran_id', async (req, res) => {
  const tran_id = req.params.tran_id;
  const paymentInfo = paymentStatusMap[tran_id];
  const paymentData = paymentDataMap[tran_id];
  
  if (!paymentInfo && !paymentData) {
    return res.json({ 
      transactionId: tran_id,
      status: 'UNKNOWN',
      paymentData: null,
      transactionDetails: null,
      message: 'Transaction not found'
    });
  }
  
  // Handle case where paymentInfo is a string (legacy) or object (new format)
  let status, transactionDetails;
  if (typeof paymentInfo === 'string') {
    status = paymentInfo;
    transactionDetails = null;
  } else if (typeof paymentInfo === 'object' && paymentInfo !== null) {
    status = paymentInfo.status;
    transactionDetails = paymentInfo;
  } else {
    status = 'PENDING';
    transactionDetails = null;
  }
  
  // If status is still PENDING, try to check with SSL Commerce
  if (status === 'PENDING' && paymentData) {
    try {
      const validationData = {
        val_id: tran_id,
        store_id: 'patua685d01b8d4ca6',
        store_passwd: 'patua685d01b8d4ca6@ssl',
        format: 'json'
      };

      const params = new URLSearchParams(validationData).toString();
      
      const sslcResponse = await axios.get(
        `https://sandbox.sslcommerz.com/validator/api/validationserverAPI.php?${params}`,
        { timeout: 5000 } // 5 second timeout
      );

      if (sslcResponse.data && sslcResponse.data.status) {
        const sslcStatus = sslcResponse.data.status;
        let mappedStatus;
        
        switch (sslcStatus.toLowerCase()) {
          case 'valid':
          case 'validated':
            mappedStatus = 'VALID';
            break;
          case 'failed':
            mappedStatus = 'FAILED';
            break;
          case 'cancelled':
            mappedStatus = 'CANCELLED';
            break;
          default:
            mappedStatus = 'PENDING';
        }

        // Update local status if it changed
        if (mappedStatus !== 'PENDING') {
          paymentStatusMap[tran_id] = {
            status: mappedStatus,
            amount: sslcResponse.data.amount || paymentData.amount,
            currency: sslcResponse.data.currency || 'BDT',
            bank_tran_id: sslcResponse.data.bank_tran_id || null,
            card_type: sslcResponse.data.card_type || null,
            processedAt: new Date().toISOString(),
            paymentData: paymentData,
            sslcResponse: sslcResponse.data
          };
          
          status = mappedStatus;
          transactionDetails = paymentStatusMap[tran_id];
          
          console.log(`🔄 Auto-updated status for ${tran_id}: ${mappedStatus}`);
        }
      }
    } catch (error) {
      console.log(`⚠️ Could not auto-check status with SSL Commerce for ${tran_id}:`, error.message);
      // Continue with existing status if SSL Commerce check fails
    }
  }
  
  const response = {
    transactionId: tran_id,
    status: status,
    paymentData: paymentData || null,
    transactionDetails: transactionDetails,
    message: getStatusMessage(status)
  };
  
  res.json(response);
});

// Helper function to get user-friendly status messages
function getStatusMessage(status) {
  switch (status) {
    case 'VALID':
    case 'VALIDATED':
      return 'Payment completed successfully';
    case 'FAILED':
      return 'Payment failed. Please try again.';
    case 'CANCELLED':
      return 'Payment was cancelled by user';
    case 'PENDING':
      return 'Payment is being processed';
    default:
      return 'Payment status unknown';
  }
}

// Endpoint to validate and finalize payment
app.post('/validate-payment', async (req, res) => {
  const { tran_id, userId, planId } = req.body;
  
  if (!tran_id || !userId || !planId) {
    return res.status(400).json({
      error: 'Missing required fields: tran_id, userId, planId'
    });
  }
  
  const paymentInfo = paymentStatusMap[tran_id];
  const paymentData = paymentDataMap[tran_id];
  
  if (!paymentInfo || !paymentData) {
    return res.status(404).json({
      error: 'Payment record not found'
    });
  }
  
  // Validate the payment belongs to the user
  if (paymentData.userId !== userId || paymentData.planId !== planId) {
    return res.status(403).json({
      error: 'Payment validation failed: user or plan mismatch'
    });
  }
  
  // Handle case where paymentInfo is a string (legacy) or object (new format)
  let status;
  if (typeof paymentInfo === 'string') {
    status = paymentInfo;
  } else if (typeof paymentInfo === 'object' && paymentInfo !== null) {
    status = paymentInfo.status;
  } else {
    status = 'PENDING';
  }
  
  if (status === 'VALID' || status === 'VALIDATED') {
    return res.json({
      success: true,
      message: 'Payment validated successfully',
      paymentData,
      transactionDetails: paymentInfo
    });
  } else {
    return res.json({
      success: false,
      message: `Payment not completed. Status: ${status}`,
      paymentData,
      transactionDetails: paymentInfo
    });
  }
});

// Static success/fail pages - handle both GET and POST
app.get('/success', (req, res) => {
  const { tran_id } = req.query;
  
  // Mark payment as successful when SSL Commerce redirects here
  if (tran_id && paymentDataMap[tran_id]) {
    paymentStatusMap[tran_id] = {
      status: 'VALID',
      amount: paymentDataMap[tran_id].amount,
      currency: 'BDT',
      bank_tran_id: `REDIRECT_${Date.now()}`,
      card_type: 'Unknown',
      processedAt: new Date().toISOString(),
      paymentData: paymentDataMap[tran_id],
      redirectType: 'GET'
    };
    
    console.log(`✅ Payment marked as successful via redirect: ${tran_id}`);
  }
  
  res.send(`
    <h2>✅ Payment Successful</h2>
    <p>Transaction ID: ${tran_id || 'N/A'}</p>
    <p>Your payment has been processed successfully!</p>
    <p>You may close this window and return to the app.</p>
    <script>
      // Try to close the window after 3 seconds
      setTimeout(() => {
        window.close();
      }, 3000);
    </script>
  `);
});

app.post('/success', (req, res) => {
  const { tran_id } = req.body;
  
  // Mark payment as successful when SSL Commerce redirects here
  if (tran_id && paymentDataMap[tran_id]) {
    paymentStatusMap[tran_id] = {
      status: 'VALID',
      amount: paymentDataMap[tran_id].amount,
      currency: 'BDT',
      bank_tran_id: `REDIRECT_${Date.now()}`,
      card_type: 'Unknown',
      processedAt: new Date().toISOString(),
      paymentData: paymentDataMap[tran_id],
      redirectType: 'POST'
    };
    
    console.log(`✅ Payment marked as successful via redirect: ${tran_id}`);
  }
  
  res.send(`
    <h2>✅ Payment Successful</h2>
    <p>Transaction ID: ${tran_id || 'N/A'}</p>
    <p>Your payment has been processed successfully!</p>
    <p>You may close this window and return to the app.</p>
    <script>
      // Try to close the window after 3 seconds
      setTimeout(() => {
        window.close();
      }, 3000);
    </script>
  `);
});

app.get('/fail', (req, res) => {
  const { tran_id } = req.query;
  
  // Mark payment as failed when SSL Commerce redirects here
  if (tran_id && paymentDataMap[tran_id]) {
    paymentStatusMap[tran_id] = {
      status: 'FAILED',
      amount: paymentDataMap[tran_id].amount,
      currency: 'BDT',
      bank_tran_id: null,
      card_type: null,
      processedAt: new Date().toISOString(),
      paymentData: paymentDataMap[tran_id],
      redirectType: 'GET'
    };
    
    console.log(`❌ Payment marked as failed via redirect: ${tran_id}`);
  }
  
  res.send(`
    <h2>❌ Payment Failed</h2>
    <p>Transaction ID: ${tran_id || 'N/A'}</p>
    <p>Your payment could not be processed. Please try again.</p>
    <p>You may close this window and return to the app.</p>
    <script>
      // Try to close the window after 3 seconds
      setTimeout(() => {
        window.close();
      }, 3000);
    </script>
  `);
});

app.post('/fail', (req, res) => {
  const { tran_id } = req.body;
  
  // Mark payment as failed when SSL Commerce redirects here
  if (tran_id && paymentDataMap[tran_id]) {
    paymentStatusMap[tran_id] = {
      status: 'FAILED',
      amount: paymentDataMap[tran_id].amount,
      currency: 'BDT',
      bank_tran_id: null,
      card_type: null,
      processedAt: new Date().toISOString(),
      paymentData: paymentDataMap[tran_id],
      redirectType: 'POST'
    };
    
    console.log(`❌ Payment marked as failed via redirect: ${tran_id}`);
  }
  
  res.send(`
    <h2>❌ Payment Failed</h2>
    <p>Transaction ID: ${tran_id || 'N/A'}</p>
    <p>Your payment could not be processed. Please try again.</p>
    <p>You may close this window and return to the app.</p>
    <script>
      // Try to close the window after 3 seconds
      setTimeout(() => {
        window.close();
      }, 3000);
    </script>
  `);
});

app.get('/cancel', (req, res) => {
  const { tran_id } = req.query;
  
  // Mark payment as cancelled when SSL Commerce redirects here
  if (tran_id && paymentDataMap[tran_id]) {
    paymentStatusMap[tran_id] = {
      status: 'CANCELLED',
      amount: paymentDataMap[tran_id].amount,
      currency: 'BDT',
      bank_tran_id: null,
      card_type: null,
      processedAt: new Date().toISOString(),
      paymentData: paymentDataMap[tran_id],
      redirectType: 'GET'
    };
    
    console.log(`⚠️ Payment marked as cancelled via redirect: ${tran_id}`);
  }
  
  res.send(`
    <h2>⚠️ Payment Cancelled</h2>
    <p>Transaction ID: ${tran_id || 'N/A'}</p>
    <p>Payment was cancelled by user.</p>
    <p>You may close this window and return to the app.</p>
    <script>
      // Try to close the window after 3 seconds
      setTimeout(() => {
        window.close();
      }, 3000);
    </script>
  `);
});

app.post('/cancel', (req, res) => {
  const { tran_id } = req.body;
  
  // Mark payment as cancelled when SSL Commerce redirects here
  if (tran_id && paymentDataMap[tran_id]) {
    paymentStatusMap[tran_id] = {
      status: 'CANCELLED',
      amount: paymentDataMap[tran_id].amount,
      currency: 'BDT',
      bank_tran_id: null,
      card_type: null,
      processedAt: new Date().toISOString(),
      paymentData: paymentDataMap[tran_id],
      redirectType: 'POST'
    };
    
    console.log(`⚠️ Payment marked as cancelled via redirect: ${tran_id}`);
  }
  
  res.send(`
    <h2>⚠️ Payment Cancelled</h2>
    <p>Transaction ID: ${tran_id || 'N/A'}</p>
    <p>Payment was cancelled by user.</p>
    <p>You may close this window and return to the app.</p>
    <script>
      // Try to close the window after 3 seconds
      setTimeout(() => {
        window.close();
      }, 3000);
    </script>
  `);
});

// Test endpoint to simulate successful payment
app.post('/test-success/:tran_id', (req, res) => {
  const tran_id = req.params.tran_id;
  
  if (!paymentStatusMap[tran_id] && !paymentDataMap[tran_id]) {
    return res.status(404).json({ error: 'Transaction not found' });
  }
  
  // Simulate successful payment
  paymentStatusMap[tran_id] = {
    status: 'VALID',
    amount: paymentDataMap[tran_id]?.amount || '500.00',
    currency: 'BDT',
    bank_tran_id: `BANK_${Date.now()}`,
    card_type: 'VISA-Debit',
    processedAt: new Date().toISOString(),
    paymentData: paymentDataMap[tran_id] || null
  };
  
  console.log(`✅ Test: Marked payment ${tran_id} as successful`);
  
  res.json({
    success: true,
    message: 'Payment marked as successful for testing',
    transactionId: tran_id,
    status: 'VALID'
  });
});

// Test endpoint to simulate failed payment
app.post('/test-fail/:tran_id', (req, res) => {
  const tran_id = req.params.tran_id;
  
  if (!paymentStatusMap[tran_id] && !paymentDataMap[tran_id]) {
    return res.status(404).json({ error: 'Transaction not found' });
  }
  
  // Simulate failed payment
  paymentStatusMap[tran_id] = {
    status: 'FAILED',
    amount: paymentDataMap[tran_id]?.amount || '500.00',
    currency: 'BDT',
    bank_tran_id: null,
    card_type: null,
    processedAt: new Date().toISOString(),
    paymentData: paymentDataMap[tran_id] || null
  };
  
  console.log(`❌ Test: Marked payment ${tran_id} as failed`);
  
  res.json({
    success: true,
    message: 'Payment marked as failed for testing',
    transactionId: tran_id,
    status: 'FAILED'
  });
});

// Manual status check endpoint (validates with SSL Commerce directly)
app.post('/check-payment-with-sslc/:tran_id', async (req, res) => {
  const tran_id = req.params.tran_id;
  
  if (!paymentDataMap[tran_id]) {
    return res.status(404).json({ error: 'Transaction not found' });
  }

  try {
    // Check with SSL Commerce validation API
    const validationData = {
      val_id: tran_id,
      store_id: 'patua685d01b8d4ca6',
      store_passwd: 'patua685d01b8d4ca6@ssl',
      format: 'json'
    };

    const params = new URLSearchParams(validationData).toString();
    
    const response = await axios.get(
      `https://sandbox.sslcommerz.com/validator/api/validationserverAPI.php?${params}`
    );

    console.log(`SSL Commerce validation response for ${tran_id}:`, response.data);

    if (response.data && response.data.status) {
      // Update our local status based on SSL Commerce response
      const sslcStatus = response.data.status;
      let mappedStatus;
      
      switch (sslcStatus.toLowerCase()) {
        case 'valid':
        case 'validated':
          mappedStatus = 'VALID';
          break;
        case 'failed':
          mappedStatus = 'FAILED';
          break;
        case 'cancelled':
          mappedStatus = 'CANCELLED';
          break;
        default:
          mappedStatus = 'PENDING';
      }

      // Update local status
      paymentStatusMap[tran_id] = {
        status: mappedStatus,
        amount: response.data.amount || paymentDataMap[tran_id].amount,
        currency: response.data.currency || 'BDT',
        bank_tran_id: response.data.bank_tran_id || null,
        card_type: response.data.card_type || null,
        processedAt: new Date().toISOString(),
        paymentData: paymentDataMap[tran_id],
        sslcResponse: response.data // Store full SSL Commerce response
      };

      console.log(`✅ Updated status for ${tran_id}: ${mappedStatus}`);
      
      return res.json({
        success: true,
        transactionId: tran_id,
        status: mappedStatus,
        message: getStatusMessage(mappedStatus),
        sslcData: response.data
      });
    } else {
      return res.json({
        success: false,
        message: 'Unable to verify payment status with SSL Commerce',
        transactionId: tran_id
      });
    }
  } catch (error) {
    console.error(`Error checking payment status with SSL Commerce:`, error.message);
    return res.status(500).json({
      error: 'Failed to check payment status',
      transactionId: tran_id
    });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
