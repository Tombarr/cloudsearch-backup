import { CloudSearchDomainClient, SearchCommand, UploadDocumentsCommand } from '@aws-sdk/client-cloudsearch-domain';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import process from 'process';
import path from 'path';
import fs from 'fs';
import { finished } from 'stream/promises';
import fsPromises from 'fs/promises';
import { isTrue, today, timeOfDay } from './helpers.mjs';

// Environment Variables
const {
    BUCKET_NAME = '',
    DOCUMENT_ENDPOINT = '',
    AWS_REGION = '',
    REGION = AWS_REGION,
    ONE_SHOT = 0, // 0 = false
    BATCH_SIZE = 10000,
    BACKUP_INDEX_NAME = 'csbackup.json',
    ENCODING = 'utf-8',
    SINGLE_FILE = 1, // 1 = true
} = process.env;

const IS_ONE_SHOT = isTrue(ONE_SHOT);
const IS_SINGLE_FILE = isTrue(SINGLE_FILE);

// Store for repeat invocations
const todayPath = today();
const timeOfDayPath = timeOfDay();

// i.e. YYYY-MM-DD/HH:MM/csbackup.json (no leading slash)
const getTimedBackupName = (fileName = BACKUP_INDEX_NAME) =>
    path.join(...[todayPath, timeOfDayPath, fileName]);
const getBackupName = () => (IS_ONE_SHOT) ? BACKUP_INDEX_NAME : getTimedBackupName();

// AWS SDK Clients
const s3Client = new S3Client({ region: REGION });
const searchDomainClient = new CloudSearchDomainClient({
    endpoint: DOCUMENT_ENDPOINT,
    region: REGION,
});

// SearchCommand to return all matched fields
const getSearchCommand = (cursor) => new SearchCommand({
    query: "matchall",
    cursor: (!cursor) ? "initial" : cursor,
    size: BATCH_SIZE,
    queryParser: "structured",
    return: "_all_fields"
});

/**
 * A Lambda function to backup a CloudSearch instance
 * to an S3 bucket
 */
export const backup = async () => {
    const start = Date.now();
    console.log({ function: 'backup', start, env: process.env });

    const backupName = getBackupName();
    const tmpName = path.join('/tmp', BACKUP_INDEX_NAME);
    let tmpStream = fs.createWriteStream(tmpName, { flags: 'a+', encoding: ENCODING });
    tmpStream.write('[\n');

    const batchKeys = [];
    let batchIndex = 0;
    let csTimems = 0;
    let hits = 0;
    let byteLength = 0;

    // Load first search document batch
    let resultBatch = await searchDomainClient.send(getSearchCommand());
    let batchHits = (resultBatch) ? resultBatch.hits.hit.length : 0;

    // Poll for document batches and write to S3
    while (resultBatch && resultBatch.hits.hit.length) {
        const documentBatch = JSON.stringify(resultBatch.hits.hit);

        if (IS_SINGLE_FILE) {
            // Write document batch to temporary storage
            if (batchIndex > 0) {
                tmpStream.write(',\n', ENCODING);
            }
            tmpStream.write(documentBatch.substring(1, documentBatch.length - 1), ENCODING);
        } else {
            // Prepare batch backup
            const batchKey = getTimedBackupName(`${batchIndex}.json`);
            batchKeys.push(batchKey);
            byteLength += documentBatch.length;

            // Save current batch to S3
            await s3Client.send(new PutObjectCommand({
                Body: documentBatch,
                Bucket: BUCKET_NAME,
                Key: batchKey,
            }));
        }

        batchHits = (resultBatch) ? resultBatch.hits.hit.length : 0;
        hits += batchHits;
        csTimems += resultBatch.status.timems;
        batchIndex += 1;
        byteLength += documentBatch.length;

        // Log current stats
        console.log({ batch: batchIndex, hits: batchHits, totalHits: hits });

        // Get next document batch
        resultBatch = await searchDomainClient.send(
            getSearchCommand(resultBatch.hits.cursor)
        );
    }

    const backupStats = {
        batches: batchIndex + 1,
        batchSize: BATCH_SIZE,
        time: Date.now(),
        region: REGION,
        documentEndpoint: DOCUMENT_ENDPOINT,
        batchFiles: (IS_SINGLE_FILE) ? undefined : batchKeys,
        stats: {
            csTimeMs: csTimems,
            elapsedMs: Date.now() - start,
            documents: hits,
            byteLength: byteLength,
        },
    };

    if (IS_SINGLE_FILE) {
        // Write final character
        tmpStream.end('\n]', ENCODING);
        await finished(tmpStream);
        const tmpStats = await fsPromises.stat(tmpName);
        backupStats.stats.size = tmpStats.size;
        tmpStream = fs.createReadStream(tmpName, { encoding: ENCODING });

        // Write backup from ephemeral storage stream
        await s3Client.send(new PutObjectCommand({
            Bucket: BUCKET_NAME,
            Key: backupName,
            Body: tmpStream,
            ContentType: 'application/json',
        }));
    } else {
        // Write backup index details to backup path
        await s3Client.send(new PutObjectCommand({
            Body: JSON.stringify(backupStats),
            Bucket: BUCKET_NAME,
            Key: backupName,
        }));
    }

    console.log(backupStats);
    console.log({ function: 'backup', end: Date.now() - start });
    return 'OK';
}
