// File: cdk-infra/lib/stacks/amplify-infrastructure-stack.ts

import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as amplify from '@aws-cdk/aws-amplify-alpha';
import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as waf from 'aws-cdk-lib/aws-wafv2';

export class AmplifyInfrastructureStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // DynamoDB Tables
    const reportsTable = new dynamodb.Table(this, 'ReportsTable', {
      partitionKey: { name: 'id', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'timestamp', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      stream: dynamodb.StreamViewType.NEW_IMAGE,
    });

    const locationsTable = new dynamodb.Table(this, 'LocationsTable', {
      partitionKey: { name: 'reportId', type: dynamodb.AttributeType.STRING },
      encryption: dynamodb.TableEncryption.AWS_MANAGED,
      pointInTimeRecovery: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // S3 Bucket for Media Files
    const mediaBucket = new s3.Bucket(this, 'MediaBucket', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      cors: [
        {
          allowedMethods: [s3.HttpMethods.PUT, s3.HttpMethods.POST, s3.HttpMethods.GET],
          allowedOrigins: ['*'], // Will be restricted in production
          allowedHeaders: ['*'],
        },
      ],
      lifecycleRules: [
        {
          expiration: cdk.Duration.days(365),
          transitions: [
            {
              storageClass: s3.StorageClass.INFREQUENT_ACCESS,
              transitionAfter: cdk.Duration.days(30),
            },
          ],
        },
      ],
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Lambda Function for Report Submission
    const reportSubmissionFn = new lambda.Function(this, 'ReportSubmissionFunction', {
      runtime: lambda.Runtime.NODEJS_18_X,
      handler: 'index.handler',
      code: lambda.Code.fromAsset('lambda/report-submission/dist'),
      environment: {
        REPORTS_TABLE: reportsTable.tableName,
        LOCATIONS_TABLE: locationsTable.tableName,
        MEDIA_BUCKET: mediaBucket.bucketName,
      },
      timeout: cdk.Duration.seconds(30),
      memorySize: 512,
    });

    // Grant permissions
    reportsTable.grantReadWriteData(reportSubmissionFn);
    locationsTable.grantReadWriteData(reportSubmissionFn);
    mediaBucket.grantReadWrite(reportSubmissionFn);

    // API Gateway
    const api = new apigateway.RestApi(this, 'SafetyReportingApi', {
      description: 'API for community safety reporting',
      defaultCorsPreflightOptions: {
        allowOrigins: apigateway.Cors.ALL_ORIGINS, // Will be restricted in production
        allowMethods: apigateway.Cors.ALL_METHODS,
        allowHeaders: apigateway.Cors.DEFAULT_HEADERS,
      },
    });

    const reportResource = api.root.addResource('reports');
    reportResource.addMethod('POST', new apigateway.LambdaIntegration(reportSubmissionFn));

    // Basic WAF Configuration for API Gateway
    const apiWaf = new waf.CfnWebACL(this, 'ApiWaf', {
      defaultAction: { allow: {} },
      scope: 'REGIONAL',
      visibilityConfig: {
        cloudWatchMetricsEnabled: true,
        metricName: 'SafetyApiWaf',
        sampledRequestsEnabled: true,
      },
      rules: [
        {
          name: 'AWS-AWSManagedRulesCommonRuleSet',
          priority: 1,
          overrideAction: { none: {} },
          statement: {
            managedRuleGroupStatement: {
              vendorName: 'AWS',
              name: 'AWSManagedRulesCommonRuleSet',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'AWS-AWSManagedRulesCommonRuleSet',
            sampledRequestsEnabled: true,
          },
        },
        {
          name: 'RateLimitRule',
          priority: 2,
          action: { block: {} },
          statement: {
            rateBasedStatement: {
              limit: 1000,
              aggregateKeyType: 'IP',
            },
          },
          visibilityConfig: {
            cloudWatchMetricsEnabled: true,
            metricName: 'RateLimitRule',
            sampledRequestsEnabled: true,
          },
        },
      ],
    });

    // Associate WAF with API Gateway
    new waf.CfnWebACLAssociation(this, 'ApiWafAssociation', {
      resourceArn: `arn:aws:apigateway:${this.region}::/restapis/${api.restApiId}/stages/${api.deploymentStage.stageName}`,
      webAclArn: apiWaf.attrArn,
    });

    // Amplify App for Frontend Hosting
    // Create a role for Amplify to access other AWS services
    const amplifyServiceRole = new iam.Role(this, 'AmplifyServiceRole', {
      assumedBy: new iam.ServicePrincipal('amplify.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AdministratorAccess-Amplify')
      ]
    });

    // Create the Amplify app - replace with your GitHub details
    const amplifyApp = new amplify.App(this, 'SafetyReportingApp', {
      sourceCodeProvider: new amplify.GitHubSourceCodeProvider({
        owner: 'suleimanodetoro',
        repository: 'infrastructure-reporting-system', // Your repository name
        oauthToken: cdk.SecretValue.secretsManager('github-token') // Stored in Secrets Manager
      }),
      role: amplifyServiceRole,
      buildSpec: codebuild.BuildSpec.fromObjectToYaml({
        version: '1.0',
        frontend: {
          phases: {
            preBuild: {
              commands: [
                'cd frontend',
                'npm ci'
              ]
            },
            build: {
              commands: [
                'npm run build'
              ]
            }
          },
          artifacts: {
            baseDirectory: 'frontend/.next',
            files: ['**/*']
          },
          cache: {
            paths: ['frontend/node_modules/**/*']
          }
        }
      }),
      // Set environment variables for the build
      environmentVariables: {
        NEXT_PUBLIC_API_ENDPOINT: api.url
      },
      platform: amplify.Platform.WEB_COMPUTE
    });

    // Add branches
    const mainBranch = amplifyApp.addBranch('main', {
      autoBuild: true,
      stage: 'PRODUCTION'
    });

    const devBranch = amplifyApp.addBranch('dev', {
      autoBuild: true,
      stage: 'DEVELOPMENT'
    });

    // Outputs
    new cdk.CfnOutput(this, 'MediaBucketName', {
      value: mediaBucket.bucketName
    });
    
    new cdk.CfnOutput(this, 'ApiEndpoint', {
      value: api.url
    });
    
    new cdk.CfnOutput(this, 'AmplifyAppId', {
      value: amplifyApp.appId
    });
    
    new cdk.CfnOutput(this, 'AmplifyAppURL', {
      value: `https://main.${amplifyApp.appId}.amplifyapp.com`
    });
  }
}