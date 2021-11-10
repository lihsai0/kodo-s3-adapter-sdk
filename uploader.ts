import { Adapter, Part, ProgressCallback, SetObjectHeader, StorageObject } from './adapter';
import { FileHandle } from 'fs/promises';
import { Throttle, ThrottleGroup, ThrottleOptions } from 'stream-throttle';

export class Uploader {
    private aborted = false;
    private static readonly userCanceledError = new Error('User Canceled');

    constructor(private readonly adapter: Adapter) {
    }

    async putObjectFromFile(
        region: string,
        object: StorageObject,
        file: FileHandle,
        fileSize: number,
        originalFileName: string,
        putFileOption?: PutFileOption,
    ): Promise<void> {
        this.aborted = false;

        if (this.aborted) {
            throw Uploader.userCanceledError;
        }

        const partSize = putFileOption?.partSize ?? (1 << 22);
        const partsCount = partsCountOfFile(fileSize, partSize);


        if (putFileOption?.uploadThreshold && fileSize <= putFileOption!.uploadThreshold || partsCount <= 1) {
            await this.putObject(region, object, file, fileSize, originalFileName, putFileOption);
            return;
        }

        const recovered = await this.initParts(region, object, originalFileName, putFileOption);
        if (this.aborted) {
            throw Uploader.userCanceledError;
        }

        putFileOption?.putCallback?.partsInitCallback?.(recovered);

        const uploaded = uploadedSizeOfParts(recovered.parts, fileSize, partSize);
        await this.uploadParts(
            region,
            object,
            file,
            fileSize,
            uploaded,
            recovered,
            1,
            partsCount,
            partSize,
            putFileOption || {},
        );
        if (this.aborted) {
            throw Uploader.userCanceledError;
        }

        recovered.parts.sort((part1, part2) => part1.partNumber - part2.partNumber);
        await this.adapter.completeMultipartUpload(
            region,
            object,
            recovered.uploadId,
            recovered.parts,
            originalFileName,
            putFileOption?.header,
        );
    }

    abort(): void {
        this.aborted = true;
    }

    private async putObject(
        region: string,
        object: StorageObject,
        file: FileHandle,
        fileSize: number,
        originalFileName: string,
        putFileOption?: PutFileOption,
    ): Promise<void> {
        const data = Buffer.alloc(fileSize);
        const { bytesRead } = await file.read(data, 0, fileSize, 0);

        if (this.aborted) {
            throw Uploader.userCanceledError;
        }

        let throttle: Throttle | undefined;
        if (putFileOption?.uploadThrottleOption) {
            const throttleGroup = putFileOption?.uploadThrottleGroup ?? new ThrottleGroup(putFileOption.uploadThrottleOption);
            throttle = throttleGroup.throttle(putFileOption.uploadThrottleOption);
        }
        await this.adapter.putObject(
            region,
            object,
            data.subarray(0, bytesRead),
            originalFileName,
            putFileOption?.header,
            {
                progressCallback: putFileOption?.putCallback?.progressCallback,
                throttle,
            },
        );
    }

    private async initParts(
        region: string,
        object: StorageObject,
        originalFileName: string,
        putFileOption?: PutFileOption,
    ): Promise<RecoveredOption> {
        const recovered: RecoveredOption = { uploadId: '', parts: [] };

        if (putFileOption?.recovered && checkParts(putFileOption.recovered.parts)) {
            recovered.uploadId = putFileOption.recovered.uploadId;
            recovered.parts = recovered.parts.concat(putFileOption.recovered.parts);
            return recovered;
        }
        const initPartsOutput = await this.adapter.createMultipartUpload(region, object, originalFileName, putFileOption?.header);
        recovered.uploadId = initPartsOutput.uploadId;
        return recovered;
    }

    private async uploadParts(
        region: string,
        object: StorageObject,
        file: FileHandle,
        fileSize: number,
        uploaded: number,
        recovered: RecoveredOption,
        partNumber: number,
        partsCount: number,
        partSize: number,
        putFileOption: PutFileOption,
    ): Promise<void> {
        if (partNumber > partsCount) {
            return;
        }

        if (this.aborted) {
            throw Uploader.userCanceledError;
        }

        if (findPartsByNumber(recovered.parts, partNumber)) {
            await this.uploadParts(
                region,
                object,
                file,
                fileSize,
                uploaded,
                recovered,
                partNumber + 1,
                partsCount,
                partSize,
                putFileOption,
            );
            return;
        }

        let data: Buffer | undefined = Buffer.alloc(partSize);
        const { bytesRead } = await file.read(data, 0, partSize, partSize * (partNumber - 1));
        if (this.aborted) {
            throw Uploader.userCanceledError;
        }

        const makeThrottle = (): Throttle | undefined => {
            if (!putFileOption.uploadThrottleOption) {
                return;
            }
            if (!putFileOption.uploadThrottleGroup) {
                putFileOption.uploadThrottleGroup = new ThrottleGroup(putFileOption.uploadThrottleOption);
            }
            return putFileOption.uploadThrottleGroup.throttle(putFileOption.uploadThrottleOption);
        };

        let progressCallback: ProgressCallback | undefined;
        if (putFileOption.putCallback?.progressCallback) {
            progressCallback = (partUploaded: number, _partTotal: number) => {
                putFileOption.putCallback!.progressCallback!(uploaded + partUploaded, fileSize);
            };
        }
        const output = await this.adapter.uploadPart(
            region,
            object,
            recovered.uploadId,
            partNumber,
            data!.subarray(0, bytesRead),
            {
                progressCallback,
                throttle: makeThrottle(),
            },
        );

        data = undefined;
        const part: Part = { etag: output.etag, partNumber };
        putFileOption?.putCallback?.partPutCallback?.(part);
        recovered.parts.push(part);
        uploaded += bytesRead;
        await this.uploadParts(
            region,
            object,
            file,
            fileSize,
            uploaded,
            recovered,
            partNumber + 1,
            partsCount,
            partSize,
            putFileOption,
        );
    }
}

export interface PutCallback {
    progressCallback?: ProgressCallback;
    partsInitCallback?: (initInfo: RecoveredOption) => void;
    partPutCallback?: (part: Part) => void;
}

export interface PutFileOption {
    header?: SetObjectHeader;
    recovered?: RecoveredOption,
    putCallback?: PutCallback;
    partSize?: number;
    uploadThreshold?: number;
    uploadThrottleGroup?: ThrottleGroup;
    uploadThrottleOption?: ThrottleOptions;
}

export interface RecoveredOption {
    uploadId: string,
    parts: Part[],
}

function checkParts(parts: Part[]): boolean {
    const partNumbers = new Set<number>();

    for (const part of parts) {
        partNumbers.add(part.partNumber);
    }

    return partNumbers.size === parts.length;
}

function findPartsByNumber(parts: Part[], partNumber: number): Part | undefined {
    return parts.find((part) => part.partNumber === partNumber);
}

function partsCountOfFile(fileSize: number, partSize: number): number {
    const count = (fileSize + partSize - 1) / partSize;
    return ~~count;
}

function uploadedSizeOfParts(parts: Part[], fileSize: number, partSize: number): number {
    const partsCount = partsCountOfFile(fileSize, partSize);
    let uploaded = 0;
    parts.forEach((part) => {
        uploaded += partSize;
        if (part.partNumber === partsCount) {
            uploaded -= (partSize * partsCount - fileSize);
        }
    });
    return uploaded;
}
