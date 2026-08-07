import { Pipe, PipeTransform } from '@angular/core';

@Pipe({
    name: 'timeUntil'
})
export class TimeUntilPipe implements PipeTransform {

    transform(value: any): string {
        if (!value) return '';

        const targetDate = new Date(value);
        const now = new Date();
        const seconds = Math.floor((targetDate.getTime() - now.getTime()) / 1000);
        const formattedDate = this.formatExactDate(targetDate);

        if (seconds < 0)
            return `Expired (${formattedDate})`;

        const intervals: { [key: string]: number } = {
            'year': 31536000,
            'month': 2592000,
            'week': 604800,
            'day': 86400,
            'hour': 3600
        };

        let counter;
        let relativeString = '';

        for (const i in intervals) {
            counter = Math.floor(seconds / intervals[i]);
            if (counter > 0) {
                if (counter === 1) {
                    relativeString = `In ${counter} ${i}`;
                } else {
                    relativeString = `In ${counter} ${i}s`;
                }
                break;
            }
        }

        if (!relativeString) {
            relativeString = 'In less than an hour';
        }

        return `${relativeString} (${formattedDate})`;
    }

    private formatExactDate(date: Date): string {
        const monthNames = [
            "January", "February", "March", "April", "May", "June",
            "July", "August", "September", "October", "November", "December"
        ];

        const month = monthNames[date.getMonth()];
        const day = date.getDate();
        const year = date.getFullYear();
        const suffix = this.getOrdinalSuffix(day);

        return `${month} ${day}${suffix} ${year}`;
    }

    private getOrdinalSuffix(day: number): string {
        if (day > 3 && day < 21) return 'th';
        switch (day % 10) {
            case 1: return "st";
            case 2: return "nd";
            case 3: return "rd";
            default: return "th";
        }
    }
}