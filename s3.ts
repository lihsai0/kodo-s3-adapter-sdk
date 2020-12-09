import AsyncLock from 'async-lock';
import AWS from 'aws-sdk';
import os from 'os';
import pkg from './package.json';
import { URL } from 'url';
import { Semaphore } from 'semaphore-promise';
import { Region } from './region';
import { Kodo } from './kodo';
import { Adapter, AdapterOption, Bucket, Domain, Object, SetObjectHeader, ObjectGetResult, ObjectHeader, TransferObject, PartialObjectError, BatchCallback, FrozenInfo, FrozenStatus } from './adapter';

export const USER_AGENT: string = `Qiniu-Kodo-S3-Adapter-NodeJS-SDK/${pkg.version} (${os.type()}; ${os.platform()}; ${os.arch()}; )/s3`;

interface S3IdEndpoint {
    s3Id: string,
    s3Endpoint: string,
}

export class S3 implements Adapter {
    private allRegions: Array<Region> | undefined = undefined;
    private readonly allRegionsLock = new AsyncLock();
    private readonly bucketNameToIdCache: { [name: string]: string; } = {};
    private readonly bucketIdToNameCache: { [id: string]: string; } = {};
    private readonly clients: { [key: string]: AWS.S3; } = {};
    private readonly bucketNameToIdCacheLock = new AsyncLock();
    private readonly clientsLock = new AsyncLock();
    private readonly kodo: Kodo;

    constructor(private readonly adapterOption: AdapterOption) {
        this.kodo = new Kodo(adapterOption);
    }

    private getClient(regionId?: string): Promise<AWS.S3> {
        return new Promise((resolve, reject) => {
            const cacheKey = regionId ?? '';
            if (this.clients[cacheKey]) {
                resolve(this.clients[cacheKey]);
                return;
            }
            this.clientsLock.acquire(cacheKey, (): Promise<AWS.S3> => {
                return new Promise((resolve, reject) => {
                    let userAgent = USER_AGENT;
                    if (this.adapterOption.appendedUserAgent) {
                        userAgent += `/${this.adapterOption.appendedUserAgent}`;
                    }
                    this.getS3Endpoint(regionId).then((s3IdEndpoint) => {
                        resolve(new AWS.S3({
                            apiVersion: "2006-03-01",
                            customUserAgent: userAgent,
                            computeChecksums: true,
                            region: s3IdEndpoint.s3Id,
                            endpoint: s3IdEndpoint.s3Endpoint,
                            accessKeyId: this.adapterOption.accessKey,
                            secretAccessKey: this.adapterOption.secretKey,
                            // logger: console, TODO: Use Adapter Option here
                            maxRetries: 10,
                            s3ForcePathStyle: true,
                            signatureVersion: "v4",
                            useDualstack: true,
                            httpOptions: {
                                connectTimeout: 30000,
                                timeout: 300000,
                            }
                        }));
                    }, reject);
                });
            }).then((client: AWS.S3) => {
                this.clients[cacheKey] = client;
                resolve(client);
            }, reject);
        });
    }

    private getS3Endpoint(regionId?: string): Promise<S3IdEndpoint> {
        return new Promise((resolve, reject) => {
            let queryCondition: (region: Region) => boolean;

            if (regionId) {
                queryCondition = (region) => region.id === regionId && region.s3Urls.length > 0;
            } else {
                queryCondition = (region) => !!region.s3Id && region.s3Urls.length > 0;
            }
            const queryInRegions: (regions: Array<Region>) => void = (regions) => {
                const region: Region | undefined = regions.find(queryCondition);
                if (region) {
                    resolve({ s3Id: region.s3Id, s3Endpoint: region.s3Urls[0] });
                } else if (regionId) {
                    reject(new Error(`Cannot find region endpoint url of ${regionId}`));
                } else {
                    reject(new Error(`Cannot find valid region endpoint url`));
                }
            };

            if (this.adapterOption.regions.length > 0) {
                queryInRegions(this.adapterOption.regions);
            } else if (this.allRegions && this.allRegions.length > 0) {
                queryInRegions(this.allRegions);
            } else {
                this.allRegionsLock.acquire('all', (): Promise<Array<Region>> => {
                    if (this.allRegions && this.allRegions.length > 0) {
                        return new Promise((resolve) => { resolve(this.allRegions) });
                    }
                    return Region.getAll({
                        accessKey: this.adapterOption.accessKey,
                        secretKey: this.adapterOption.secretKey,
                        ucUrl: this.adapterOption.ucUrl,
                    });
                }).then((regions: Array<Region>) => {
                    this.allRegions = regions;
                    queryInRegions(regions);
                }, reject);
            }
        });
    }

    private fromKodoRegionIdToS3Id(regionId: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const queryCondition: (region: Region) => boolean = (region) => region.id === regionId;
            const queryInRegions: (regions: Array<Region>) => void = (regions) => {
                const region: Region | undefined = regions.find(queryCondition);
                if (region && region.s3Id) {
                    resolve(region.s3Id);
                } else {
                    reject(new Error(`Cannot find region s3 id of ${regionId}`));
                }
            };

            if (this.adapterOption.regions.length > 0) {
                queryInRegions(this.adapterOption.regions);
            } else if (this.allRegions && this.allRegions.length > 0) {
                queryInRegions(this.allRegions);
            } else {
                this.allRegionsLock.acquire('all', (): Promise<Array<Region>> => {
                    if (this.allRegions && this.allRegions.length > 0) {
                        return new Promise((resolve) => { resolve(this.allRegions) });
                    }
                    return Region.getAll({
                        accessKey: this.adapterOption.accessKey,
                        secretKey: this.adapterOption.secretKey,
                        ucUrl: this.adapterOption.ucUrl,
                    });
                }).then((regions: Array<Region>) => {
                    this.allRegions = regions;
                    queryInRegions(regions);
                }, reject);
            }
        });
    }

    private fromS3IdToKodoRegionId(s3Id: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const queryCondition: (region: Region) => boolean = (region) => region.s3Id === s3Id;
            const queryInRegions: (regions: Array<Region>) => void = (regions) => {
                const region: Region | undefined = regions.find(queryCondition);
                if (region && region.id) {
                    resolve(region.id);
                } else {
                    reject(new Error(`Cannot find region id of ${s3Id}`));
                }
            };

            if (this.adapterOption.regions.length > 0) {
                queryInRegions(this.adapterOption.regions);
            } else if (this.allRegions && this.allRegions.length > 0) {
                queryInRegions(this.allRegions);
            } else {
                this.allRegionsLock.acquire('all', (): Promise<Array<Region>> => {
                    if (this.allRegions && this.allRegions.length > 0) {
                        return new Promise((resolve) => { resolve(this.allRegions) });
                    }
                    return Region.getAll({
                        accessKey: this.adapterOption.accessKey,
                        secretKey: this.adapterOption.secretKey,
                        ucUrl: this.adapterOption.ucUrl,
                    });
                }).then((regions: Array<Region>) => {
                    this.allRegions = regions;
                    queryInRegions(regions);
                }, reject);
            }
        });
    }

    private fromKodoBucketNameToS3BucketId(bucketName: string): Promise<string> {
        return new Promise((resolve, reject) => {
            if (this.bucketNameToIdCache[bucketName]) {
                resolve(this.bucketNameToIdCache[bucketName]);
                return;
            }
            this.bucketNameToIdCacheLock.acquire('all', (): Promise<void> => {
                return new Promise((resolve, reject) => {
                    if (this.bucketNameToIdCache[bucketName]) {
                        resolve();
                        return;
                    }
                    this.kodo.listBucketIdNames().then((buckets) => {
                        buckets.forEach((bucket) => {
                            this.bucketNameToIdCache[bucket.name] = bucket.id;
                            this.bucketIdToNameCache[bucket.id] = bucket.name;
                        });
                        resolve();
                    }, reject);
                });
            }).then(() => {
                if (this.bucketNameToIdCache[bucketName]) {
                    resolve(this.bucketNameToIdCache[bucketName]);
                } else {
                    reject(new Error(`Cannot find bucket id of bucket ${bucketName}`));
                }
            }, reject);
        });
    }

    private fromS3BucketIdToKodoBucketName(bucketId: string): Promise<string> {
        return new Promise((resolve, reject) => {
            if (this.bucketIdToNameCache[bucketId]) {
                resolve(this.bucketIdToNameCache[bucketId]);
                return;
            }
            this.bucketNameToIdCacheLock.acquire('all', (): Promise<void> => {
                return new Promise((resolve, reject) => {
                    if (this.bucketIdToNameCache[bucketId]) {
                        resolve();
                        return;
                    }
                    this.kodo.listBucketIdNames().then((buckets) => {
                        buckets.forEach((bucket) => {
                            this.bucketNameToIdCache[bucket.name] = bucket.id;
                            this.bucketIdToNameCache[bucket.id] = bucket.name;
                        });
                        resolve();
                    }, reject);
                });
            }).then(() => {
                if (this.bucketIdToNameCache[bucketId]) {
                    resolve(this.bucketIdToNameCache[bucketId]);
                } else {
                    reject(new Error(`Cannot find bucket name of bucket ${bucketId}`));
                }
            }, reject);
        });
    }

    createBucket(region: string, bucket: string): Promise<void> {
        return new Promise((resolve, reject) => {
            Promise.all([this.getClient(region), this.fromKodoRegionIdToS3Id(region)]).then(([s3, s3Id]) => {
                s3.createBucket({
                    Bucket: bucket,
                    CreateBucketConfiguration: {
                        LocationConstraint: s3Id,
                    },
                }, function(err) {
                    if (err) {
                        reject(err);
                    } else {
                        resolve();
                    }
                });
            }, reject);
        });
    }

    deleteBucket(region: string, bucket: string): Promise<void> {
        return new Promise((resolve, reject) => {
            Promise.all([this.getClient(region), this.fromKodoBucketNameToS3BucketId(bucket)]).then(([s3, bucketId]) => {
                s3.deleteBucket({ Bucket: bucketId }, function(err) {
                    if (err) {
                        reject(err);
                    } else {
                        resolve();
                    }
                });
            }, reject);
        });
    }

    getBucketLocation(bucket: string): Promise<string> {
        return new Promise((resolve, reject) => {
            Promise.all([this.getClient(), this.fromKodoBucketNameToS3BucketId(bucket)]).then(([s3, bucketId]) => {
                this._getBucketLocation(s3, bucketId, resolve, reject);
            }, reject);
        });
    }

    private _getBucketLocation(s3: AWS.S3, bucketId: string, resolve: any, reject: any): void {
        s3.getBucketLocation({ Bucket: bucketId }, (err, data) => {
            if (err) {
                reject(err);
            } else {
                const s3Id: string = data.LocationConstraint!;
                this.fromS3IdToKodoRegionId(s3Id).then((regionId) => {
                    resolve(regionId);
                }, reject);
            }
        });
    }

    listBuckets(): Promise<Array<Bucket>> {
        return new Promise((resolve, reject) => {
            this.getClient().then((s3) => {
                s3.listBuckets((err, data) => {
                    if (err) {
                        reject(err);
                    } else {
                        const bucketNamePromises: Array<Promise<string>> = data.Buckets!.map((info: any) => {
                            return this.fromS3BucketIdToKodoBucketName(info.Name);
                        });
                        const bucketLocationPromises: Array<Promise<string>> = data.Buckets!.map((info: any) => {
                            return new Promise((resolve, reject) => {
                                this._getBucketLocation(s3, info.Name, resolve, reject);
                            });
                        });
                        Promise.all([Promise.all(bucketNamePromises), Promise.all(bucketLocationPromises)])
                            .then(([bucketNames, bucketLocations]) => {
                            const bucketInfos: Array<Bucket> = data.Buckets!.map((info: any, index: number) => {
                                return {
                                    id: info.Name, name: bucketNames[index],
                                    createDate: info.CreationDate,
                                    regionId: bucketLocations[index],
                                };
                            });
                            resolve(bucketInfos);
                        }, reject);
                    }
                });
            }, reject);
        });
    }

    listDomains(_region: string, _bucket: string): Promise<Array<Domain>> {
        return new Promise((resolve) => { resolve([]); });
    }

    isExists(region: string, object: Object): Promise<boolean> {
        return new Promise((resolve, reject) => {
            Promise.all([this.getClient(region), this.fromKodoBucketNameToS3BucketId(object.bucket)]).then(([s3, bucketId]) => {
                s3.listObjects({ Bucket: bucketId, MaxKeys: 1, Prefix: object.key }, (err, data) => {
                    if (err) {
                        reject(err);
                    } else if (data.Contents && data.Contents.length > 0) {
                        resolve(data.Contents[0].Key === object.key);
                    } else {
                        resolve(false);
                    }
                });
            }, reject);
        });
    }

    deleteObject(region: string, object: Object): Promise<void> {
        return new Promise((resolve, reject) => {
            Promise.all([this.getClient(region), this.fromKodoBucketNameToS3BucketId(object.bucket)]).then(([s3, bucketId]) => {
                s3.deleteObject({ Bucket: bucketId, Key: object.key }, (err) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve();
                    }
                });
            }, reject);
        });
    }

    putObject(region: string, object: Object, data: Buffer, header?: SetObjectHeader): Promise<void> {
        return new Promise((resolve, reject) => {
            Promise.all([this.getClient(region), this.fromKodoBucketNameToS3BucketId(object.bucket)]).then(([s3, bucketId]) => {
                const params: AWS.S3.Types.PutObjectRequest = {
                    Bucket: bucketId,
                    Key: object.key,
                    Body: data,
                    Metadata: header?.metadata,
                };
                s3.putObject(params, (err) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve();
                    }
                });
            }, reject);
        });
    }

    getObject(region: string, object: Object, _domain?: Domain): Promise<ObjectGetResult> {
        return new Promise((resolve, reject) => {
            Promise.all([this.getClient(region), this.fromKodoBucketNameToS3BucketId(object.bucket)]).then(([s3, bucketId]) => {
                s3.getObject({ Bucket: bucketId, Key: object.key }, (err, data) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve({
                            data: Buffer.from(data.Body!),
                            header: { size: data.ContentLength!, lastModified: data.LastModified!, metadata: data.Metadata! },
                        });
                    }
                });
            }, reject);
        });
    }

    getObjectURL(region: string, object: Object, _domain?: Domain, deadline?: Date): Promise<URL> {
        return new Promise((resolve, reject) => {
            Promise.all([this.getClient(region), this.fromKodoBucketNameToS3BucketId(object.bucket)]).then(([s3, bucketId]) => {
                let expires: number;
                if (deadline) {
                    expires = ~~((deadline.getTime() - Date.now()) / 1000);
                } else {
                    expires = 7 * 24 * 60 * 60;
                }
                const url = s3.getSignedUrl('getObject', { Bucket: bucketId, Key: object.key, Expires: expires });
                resolve(new URL(url));
            }, reject);
        });
    }

    getObjectHeader(region: string, object: Object, _domain?: Domain): Promise<ObjectHeader> {
        return new Promise((resolve, reject) => {
            Promise.all([this.getClient(region), this.fromKodoBucketNameToS3BucketId(object.bucket)]).then(([s3, bucketId]) => {
                s3.headObject({ Bucket: bucketId, Key: object.key }, (err, data) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve({ size: data.ContentLength!, lastModified: data.LastModified!, metadata: data.Metadata! });
                    }
                });
            }, reject);
        });
    }

    moveObject(region: string, transferObject: TransferObject): Promise<void> {
        return new Promise((resolve, reject) => {
            this.copyObject(region, transferObject).then(() => {
                this.deleteObject(region, transferObject.from).then(resolve, reject);
            }, reject);
        });
    }

    copyObject(region: string, transferObject: TransferObject): Promise<void> {
        return new Promise((resolve, reject) => {
            Promise.all([
                this.getClient(region),
                this.fromKodoBucketNameToS3BucketId(transferObject.from.bucket),
                this.fromKodoBucketNameToS3BucketId(transferObject.to.bucket),
            ]).then(([s3, fromBucketId, toBucketId]) => {
                const params: AWS.S3.Types.CopyObjectRequest = {
                    Bucket: toBucketId, Key: transferObject.to.key,
                    CopySource: `${fromBucketId}/${transferObject.from.key}`,
                    MetadataDirective: 'COPY',
                };
                s3.copyObject(params, (err) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve();
                    }
                });
            }, reject);
        });
    }

    moveObjects(region: string, transferObjects: Array<TransferObject>, callback?: BatchCallback): Promise<Array<PartialObjectError>> {
        return new Promise((resolve, reject) => {
            const semaphore = new Semaphore(5);
            const promises: Array<Promise<PartialObjectError>> = transferObjects.map((transferObject, index) => {
                return new Promise((resolve) => {
                    semaphore.acquire().then((release) => {
                        this.moveObject(region, transferObject).then(() => {
                            if (callback) {
                                callback(index);
                            }
                            resolve({ bucket: transferObject.from.bucket, key: transferObject.from.key });
                        }, (err) => {
                            const error = new Error(err);
                            if (callback) {
                                callback(index, error);
                            }
                            resolve({ bucket: transferObject.from.bucket, key: transferObject.from.key, error: error });
                        }).finally(() => {
                            release();
                        });
                    });
                });
            });
            Promise.all(promises).then(resolve, reject);
        });
    }

    copyObjects(region: string, transferObjects: Array<TransferObject>, callback?: BatchCallback): Promise<Array<PartialObjectError>> {
        return new Promise((resolve, reject) => {
            const semaphore = new Semaphore(5);
            const promises: Array<Promise<PartialObjectError>> = transferObjects.map((transferObject, index) => {
                return new Promise((resolve) => {
                    semaphore.acquire().then((release) => {
                        this.copyObject(region, transferObject).then(() => {
                            if (callback) {
                                callback(index);
                            }
                            resolve({ bucket: transferObject.from.bucket, key: transferObject.from.key });
                        }, (err) => {
                            const error = new Error(err);
                            if (callback) {
                                callback(index, error);
                            }
                            resolve({ bucket: transferObject.from.bucket, key: transferObject.from.key, error: error });
                        }).finally(() => {
                            release();
                        });
                    });
                });
            });
            Promise.all(promises).then(resolve, reject);
        });
    }

    deleteObjects(region: string, bucket: string, keys: Array<string>, callback?: BatchCallback): Promise<Array<PartialObjectError>> {
        return new Promise((resolve, reject) => {
            const semaphore = new Semaphore(5);
            const promises: Array<Promise<PartialObjectError>> = keys.map((key, index) => {
                return new Promise((resolve) => {
                    semaphore.acquire().then((release) => {
                        this.deleteObject(region, { bucket: bucket, key: key }).then(() => {
                            if (callback) {
                                callback(index);
                            }
                            resolve({ bucket: bucket, key: key });
                        }, (err) => {
                            const error = new Error(err);
                            if (callback) {
                                callback(index, error);
                            }
                            resolve({ bucket: bucket, key: key, error: error });
                        }).finally(() => {
                            release();
                        });
                    });
                });
            });
            Promise.all(promises).then(resolve, reject);
        });
    }

    getFrozenInfo(region: string, object: Object): Promise<FrozenInfo> {
        return new Promise((resolve, reject) => {
            Promise.all([this.getClient(region), this.fromKodoBucketNameToS3BucketId(object.bucket)]).then(([s3, bucketId]) => {
                s3.headObject({ Bucket: bucketId, Key: object.key }, (err, data) => {
                    if (err) {
                        reject(err);
                    } else if (data.StorageClass?.toLowerCase() === 'glacier') {
                        if (data.Restore) {
                            const restoreInfo = parseRestoreInfo(data.Restore);
                            if (restoreInfo.get('ongoing-request') === 'true') {
                                resolve({ status: FrozenStatus.Unfreezing });
                            } else {
                                const frozenInfo: FrozenInfo = { status: FrozenStatus.Unfrozen };
                                const expiryDate: string | undefined = restoreInfo.get('expiry-date');
                                if (expiryDate) {
                                    frozenInfo.expiryDate = new Date(expiryDate);
                                }
                                resolve(frozenInfo);
                            }
                        } else {
                            resolve({ status: FrozenStatus.Frozen });
                        }
                    } else {
                        resolve({ status: FrozenStatus.Normal });
                    }
                });
            }, reject);
        });
    }

    unfreeze(region: string, object: Object, days: number): Promise<void> {
        return new Promise((resolve, reject) => {
            Promise.all([this.getClient(region), this.fromKodoBucketNameToS3BucketId(object.bucket)]).then(([s3, bucketId]) => {
                const params: AWS.S3.Types.RestoreObjectRequest = {
                    Bucket: bucketId, Key: object.key,
                    RestoreRequest: {
                        Days: days,
                        GlacierJobParameters: { Tier: 'Standard' },
                    },
                };
                s3.restoreObject(params, (err) => {
                    if (err) {
                        reject(err);
                    } else {
                        resolve();
                    }
                });
            }, reject);
        });
    }
}

function parseRestoreInfo(s: string): Map<string, string> {
    const matches = s.match(/([\w\-]+)=\"([^\"]+)\"/g);
    const result = new Map<string, string>();
    if (matches) {
        matches.forEach((s) => {
            const pair = s.match(/([\w\-]+)=\"([^\"]+)\"/);
            if (pair && pair.length >= 3) {
                result.set(pair[1], pair[2]);
            }
        });
    }
    return result;
}
