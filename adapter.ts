import { Region } from './region';
// import { URL } from 'url';
// import { FileHandle } from 'fs/promises';

export abstract class Adapter {
    abstract createBucket(region: string, bucket: string): Promise<void>;
    abstract deleteBucket(region: string, bucket: string): Promise<void>;
    abstract getBucketLocation(bucket: string): Promise<string>;
    abstract listBuckets(): Promise<Array<Bucket>>;

    abstract isExists(region: string, object: Object): Promise<boolean>;
    // abstract getFrozenInfo(region: string, object: Object, frozen: string): Promise<FrozenInfo>;
    // abstract unfreeze(region: string, object: Object, days: number): Promise<void>;

    // abstract moveObject(region: string, transferObject: TransferObject): Promise<void>;
    // abstract moveObjects(region: string, transferObjects: Array<TransferObject>): Promise<Array<PartialObjectError>>;
    // abstract copyObject(region: string, transferObject: TransferObject): Promise<void>;
    // abstract copyObjects(region: string, transferObjects: Array<TransferObject>): Promise<Array<PartialObjectError>>;
    abstract deleteObject(region: string, object: Object): Promise<void>;
    // abstract deleteObjects(region: string, bucket: string, keys: Array<string>): Promise<Array<PartialObjectError>>;

    // abstract getObjectHeader(region: string, object: Object): Promise<ObjectHeader>;
    // abstract setObjectHeader(region: string, object: Object, header: ObjectHeader): Promise<void>;
    // abstract getObject(region: string, object: Object): Promise<ObjectGetResult>;
    // abstract getObjectURL(region: string, object: Object): Promise<URL>;
    abstract putObject(region: string, object: Object, data: Buffer, header?: SetObjectHeader): Promise<void>;
    // abstract putObjectFromFile(region: string, object: Object, file: FileHandle, putCallback?: PutCallback): Promise<void>;

    // abstract listFiles(region: string, bucket: string, prefix: string, limit?: number, nextContinuationToken?: string): Promise<Array<ObjectInfo>>;
}

export interface AdapterOption {
    accessKey: string;
    secretKey: string;
    regions: Array<Region>;
    ucUrl?: string;
    appendedUserAgent?: string;
}

export interface Bucket {
    id: string;
    name: string;
    createDate: Date;
    regionId: string;
}

export interface FrozenInfo {
    status: FrozenStatus;
    expiryDate?: Date;
}

export enum StorageClass {
    Standard,
    InfrequentAccess,
    Glacier,
}

export enum FrozenStatus {
    Normal,
    Frozen,
    Unfreezing,
    Unfrozen,
}

export interface TransferObject {
    from: Object;
    to: Object;
}

export interface Object {
    bucket: string;
    key: string;
}

export interface PartialObjectError extends Object {
    error?: Error;
}

export interface ObjectGetResult {
    data: Buffer;
    header: ObjectHeader;
}

export interface SetObjectHeader {
    filename?: string;
    metadata?: { [key: string]: string; };
}

export interface ObjectHeader extends SetObjectHeader {
    size: number;
    lastModified: Date;
    metadata: { [key: string]: string; };
}

export interface ObjectInfo extends Object {
    size: number;
    lastModified: Date;
    storageClass: StorageClass;
}

export interface PutCallback {
    progressCallback?: (uploaded: number, total: number) => void;
    partPutCallback?: (partNumber: number) => void;
}
