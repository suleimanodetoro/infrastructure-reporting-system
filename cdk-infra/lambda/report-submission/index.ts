// File: cdk-infra/lambda/report-submission/index.ts

import { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { DynamoDB, S3 } from 'aws-sdk';
import { v4 as uuidv4 } from 'uuid';

// Initialize AWS clients
const dynamoDB = new DynamoDB.DocumentClient();
const s3 = new S3();

// Environment variables
const REPORTS_TABLE = process.env.REPORTS_TABLE!;
const LOCATIONS_TABLE = process.env.LOCATIONS_TABLE!;
const MEDIA_BUCKET = process.env.MEDIA_BUCKET!;

export async function handler(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  try {
    console.log('Received event:', JSON.stringify(event, null, 2));
    
    // Parse the request body
    if (!event.body) {
      return {
        statusCode: 400,
        headers: corsHeaders(),
        body: JSON.stringify({ message: 'Request body is required' })
      };
    }
    
    const requestBody = JSON.parse(event.body);
    
    // Validate required fields
    if (!requestBody.incidentType || !requestBody.description) {
      return {
        statusCode: 400,
        headers: corsHeaders(),
        body: JSON.stringify({ message: 'Missing required fields' })
      };
    }
    
    // Generate a unique ID for the report
    const reportId = uuidv4();
    const timestamp = new Date().toISOString();
    
    // Base report data
    const reportData = {
      id: reportId,
      timestamp,
      incidentType: requestBody.incidentType,
      description: requestBody.description,
      status: 'received',
      // Add additional fields but ensure PII is handled separately
    };
    
    // Store the report in DynamoDB
    await dynamoDB.put({
      TableName: REPORTS_TABLE,
      Item: reportData
    }).promise();
    
    // Handle location data separately for privacy
    if (requestBody.incidentLocation) {
      await dynamoDB.put({
        TableName: LOCATIONS_TABLE,
        Item: {
          reportId,
          incidentLocation: requestBody.incidentLocation,
          reporterLocation: requestBody.reporterLocation || null,
          timestamp
        }
      }).promise();
    }
    
    // Handle media upload if included
    let mediaUrls = [];
    if (requestBody.mediaUrls && Array.isArray(requestBody.mediaUrls)) {
      mediaUrls = await Promise.all(
        requestBody.mediaUrls.map(async (mediaUrl: string) => {
          // For now, we assume mediaUrls are base64-encoded images
          // In a real implementation, you'd want to validate the content type, etc.
          try {
            const buffer = Buffer.from(
              mediaUrl.replace(/^data:image\/\w+;base64,/, ''),
              'base64'
            );
            
            const mediaKey = `${reportId}/${uuidv4()}`;
            
            await s3.putObject({
              Bucket: MEDIA_BUCKET,
              Key: mediaKey,
              Body: buffer,
              ContentEncoding: 'base64',
              ContentType: 'image/jpeg', // Would be determined from the actual content
              ServerSideEncryption: 'AES256'
            }).promise();
            
            return mediaKey;
          } catch (error) {
            console.error('Error uploading media:', error);
            return null;
          }
        })
      );
      
      // Filter out any failed uploads
      mediaUrls = mediaUrls.filter(url => url !== null);
      
      // Update the report with media references
      if (mediaUrls.length > 0) {
        await dynamoDB.update({
          TableName: REPORTS_TABLE,
          Key: { id: reportId, timestamp },
          UpdateExpression: 'SET mediaKeys = :mediaKeys',
          ExpressionAttributeValues: {
            ':mediaKeys': mediaUrls
          }
        }).promise();
      }
    }
    
    return {
      statusCode: 201,
      headers: corsHeaders(),
      body: JSON.stringify({
        message: 'Report submitted successfully',
        reportId
      })
    };
  } catch (error) {
    console.error('Error processing report:', error);
    return {
      statusCode: 500,
      headers: corsHeaders(),
      body: JSON.stringify({
        message: 'Error processing report',
        error: (error as Error).message
      })
    };
  }
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*', // Restrict in production
    'Access-Control-Allow-Credentials': true,
    'Content-Type': 'application/json'
  };
}